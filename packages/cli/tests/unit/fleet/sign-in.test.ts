import { describe, it } from 'bun:test';
import should from 'should';
import { runSignIn, SIGN_IN_POLL_MS } from '../../../src/lib/fleet/sign-in.ts';
import { authorityOf, fakeWorld, flow, LATER, machine } from './account-fakes.ts';

const URL = 'https://claude.ai/oauth/authorize?code=true';
const awaitingCode = (extra: Record<string, unknown> = {}) =>
  flow({ state: 'awaiting-code', verificationUrl: URL, ...extra });
const complete = () => flow({ state: 'complete', accounts: [] });
const codex = (extra: Record<string, unknown>) => flow({ harness: 'codex', credentialId: 'codex-you', ...extra });
const linkAwaiting = (extra: Record<string, unknown> = {}) =>
  codex({
    state: 'awaiting-callback',
    verificationUrl: 'https://auth.openai.com/oauth/authorize?state=s',
    ...extra,
  });

/** Answers each status read from a queue, repeating the last. */
const queue =
  <T>(items: T[]) =>
  (): T =>
    items.length > 1 ? (items.shift() as T) : (items[0] as T);

describe('runSignIn', () => {
  it('should show the page, take the pasted code and finish signed in', async () => {
    // Arrange
    const world = fakeWorld({
      answers: ['  the-code  '],
      gateway: {
        startSignIn: () => flow(),
        signInStatus: queue([awaitingCode(), awaitingCode(), complete()]),
        submitSignInCode: () => ({ outcome: 'accepted', flow: awaitingCode() }),
      },
    });

    // Act
    const signedIn = await runSignIn(world.deps, 'claude-you');

    // Assert
    should(signedIn).be.true();
    should(world.gateway.called('submitSignInCode')[0]?.args).eql(['flow-1', 'the-code']);
    should(world.prompt.questions).eql(['Paste the code the page shows:']);
    should(world.out.text('report')).equal(`Open this page and sign in:\n  ${URL}`);
    should(world.out.text('success')).equal('Signed in. claude-you is ready to use.');
    should(world.slept.every(ms => ms === SIGN_IN_POLL_MS)).be.true();
  });

  it('should say it picked up a sign-in already running, and how to start over instead', async () => {
    // Arrange — a sign-in the browser started; this terminal lands on the same one.
    const world = fakeWorld({
      answers: ['the-code'],
      gateway: {
        startSignIn: () => awaitingCode({ resumed: true }),
        submitSignInCode: () => ({ outcome: 'accepted', flow: complete() }),
      },
    });

    // Act
    const signedIn = await runSignIn(world.deps, 'claude-you');

    // Assert
    should(signedIn).be.true();
    should(world.out.text('report')).startWith(
      'A sign-in for claude-you was already running, so this picks it up. To start over instead: fz credential signin claude-you --force',
    );
  });

  it('should ask the daemon to start over when forced', async () => {
    // Arrange
    const world = fakeWorld({ gateway: { startSignIn: () => complete() } });

    // Act
    await runSignIn(world.deps, 'codex-you', { force: true });

    // Assert
    should(world.gateway.called('startSignIn')[0]?.args).eql(['codex-you', 'restart']);
    should(world.out.text('report')).equal('');
  });

  it('should ask again when the code was not accepted', async () => {
    const world = fakeWorld({
      answers: ['bad', 'good'],
      gateway: {
        startSignIn: () => awaitingCode(),
        submitSignInCode: queue([
          { outcome: 'accepted', flow: awaitingCode({ lastCode: 'rejected' }) },
          { outcome: 'accepted', flow: complete() },
        ]),
      },
    });
    should(await runSignIn(world.deps, 'claude-you')).be.true();
    should(world.prompt.questions).have.length(2);
    should(world.out.text('warn')).match(/not accepted/);
  });

  it('should keep waiting when nobody can say whether the code arrived', async () => {
    const world = fakeWorld({
      answers: ['code'],
      gateway: {
        startSignIn: () => awaitingCode(),
        submitSignInCode: () => ({ outcome: 'unconfirmed', reason: 'The sign-in may have ended.' }),
        signInStatus: () => complete(),
      },
    });
    should(await runSignIn(world.deps, 'claude-you')).be.true();
    should(world.out.text('warn')).equal('The sign-in may have ended.');
  });

  it('should stop and exit non-zero when the code is refused or empty', async () => {
    const refused = fakeWorld({
      answers: ['code'],
      gateway: {
        startSignIn: () => awaitingCode(),
        submitSignInCode: () => ({ outcome: 'conflict', reason: 'Already finished.' }),
      },
    });
    should(await runSignIn(refused.deps, 'claude-you')).be.false();
    should(refused.out.text('error')).equal('The code could not be used: Already finished.');
    should(refused.gateway.called('cancelSignIn')).have.length(1);
    should(refused.out.exitCode).equal(1);

    const empty = fakeWorld({ answers: [''], gateway: { startSignIn: () => awaitingCode() } });
    should(await runSignIn(empty.deps, 'claude-you')).be.false();
    should(empty.out.text('error')).match(/No code was given/);
  });

  it('should refuse a Claude sign-in off a terminal and stop it', async () => {
    const world = fakeWorld({
      interactive: false,
      gateway: {
        startSignIn: () => awaitingCode(),
        cancelSignIn: () => {
          throw new Error('gone');
        },
      },
    });
    await should(runSignIn(world.deps, 'claude-you')).be.rejectedWith(/needs a person to paste a code/);
    should(world.gateway.called('cancelSignIn')).have.length(1);
  });

  it('should show the Codex page and code once, then wait for the approval', async () => {
    const approval = flow({
      harness: 'codex',
      state: 'awaiting-approval',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
    const world = fakeWorld({
      gateway: {
        startSignIn: () => approval,
        signInStatus: queue([approval, flow({ harness: 'codex', state: 'complete', accounts: [] })]),
      },
    });
    should(await runSignIn(world.deps, 'codex-you')).be.true();
    should(world.out.text('report')).match(/enter the code ABCD-EFGH/);
    should(world.out.lines.filter(line => line.text.includes('ABCD-EFGH'))).have.length(1);
  });

  it('should report a failed sign-in with its way back', async () => {
    const world = fakeWorld({
      gateway: {
        startSignIn: () =>
          flow({ state: 'failed', reason: 'Claude exited.', remedy: 'Run claude auth login yourself.' }),
      },
    });
    should(await runSignIn(world.deps, 'claude-you')).be.false();
    should(world.out.text('error')).equal('Sign-in did not finish: Claude exited.');
    should(world.out.text('report')).equal('Run claude auth login yourself.');
    should(world.out.exitCode).equal(1);
  });

  it('should give up when the sign-in outlives its deadline', async () => {
    const world = fakeWorld({ now: () => Date.parse(LATER), gateway: { startSignIn: () => flow() } });
    should(await runSignIn(world.deps, 'claude-you')).be.false();
    should(world.out.text('error')).match(/took too long/);
    should(world.gateway.called('cancelSignIn')).have.length(1);
  });

  it('should ask for the address a Codex link sign-in ends on, and finish when Codex does', async () => {
    const world = fakeWorld({
      answers: ['  http://localhost:1455/auth/callback?code=c&state=s  '],
      gateway: {
        startSignIn: () => linkAwaiting({ deviceCode: 'unavailable' }),
        submitSignInCode: () => ({ outcome: 'accepted', flow: codex({ state: 'finishing' }) }),
        signInStatus: queue([codex({ state: 'finishing' }), codex({ state: 'complete' })]),
      },
    });
    should(await runSignIn(world.deps, 'codex-you')).be.true();
    should(world.gateway.called('submitSignInCode')[0]?.args).eql([
      'flow-1',
      'http://localhost:1455/auth/callback?code=c&state=s',
    ]);
    should(world.prompt.questions).eql(['Paste the address of the page that did not load:']);
    should(world.out.text('warn')).match(/does not allow device codes/);
    should(world.out.text('report')).match(
      /Open this page on any device and sign in:\n {2}https:\/\/auth\.openai\.com/,
    );
    should(world.out.text('report')).match(/http:\/\/localhost/);
    should(world.out.lines.filter(line => line.text.includes('finishing'))).have.length(1);
  });

  it('should ask again, with the reason, when the address is refused', async () => {
    const world = fakeWorld({
      answers: ['http://localhost:1455/partial', 'http://localhost:1455/auth/callback?code=c&state=s'],
      gateway: {
        startSignIn: () => linkAwaiting(),
        submitSignInCode: queue([
          { outcome: 'refused', reason: 'That address has no sign-in code in it.' },
          { outcome: 'accepted', flow: codex({ state: 'complete' }) },
        ]),
      },
    });
    should(await runSignIn(world.deps, 'codex-you')).be.true();
    should(world.prompt.questions).have.length(2);
    should(world.out.text('warn')).equal('That address has no sign-in code in it.');
    should(world.out.lines.filter(line => line.text.includes('auth.openai.com'))).have.length(1);
  });

  it('should read the sign-in back when the address arrives too late or nobody can say', async () => {
    const late = fakeWorld({
      answers: ['http://localhost:1455/auth/callback?code=c&state=s'],
      gateway: {
        startSignIn: () => linkAwaiting(),
        submitSignInCode: () => ({ outcome: 'conflict', reason: 'this login has already finished' }),
        signInStatus: () => codex({ state: 'complete' }),
      },
    });
    should(await runSignIn(late.deps, 'codex-you')).be.true();

    const unknown = fakeWorld({
      answers: ['http://localhost:1455/auth/callback?code=c&state=s'],
      gateway: {
        startSignIn: () => linkAwaiting(),
        submitSignInCode: () => ({ outcome: 'unconfirmed', reason: 'Codex was no longer listening.' }),
        signInStatus: () => codex({ state: 'complete' }),
      },
    });
    should(await runSignIn(unknown.deps, 'codex-you')).be.true();
    should(unknown.out.text('warn')).equal('Codex was no longer listening.');
  });

  it('should stop when no address is given, and refuse a link sign-in off a terminal', async () => {
    const empty = fakeWorld({ answers: [''], gateway: { startSignIn: () => linkAwaiting() } });
    should(await runSignIn(empty.deps, 'codex-you')).be.false();
    should(empty.out.text('error')).match(/No address was given/);
    should(empty.gateway.called('cancelSignIn')).have.length(1);

    const headless = fakeWorld({ interactive: false, gateway: { startSignIn: () => linkAwaiting() } });
    await should(runSignIn(headless.deps, 'codex-you')).be.rejectedWith(/needs a person to paste an address/);
  });

  it('should offer a link when a device code fails, and sign in with one when asked', async () => {
    const world = fakeWorld({
      answers: ['Y', 'http://localhost:1455/auth/callback?code=c&state=s'],
      gateway: {
        startSignIn: queue([
          codex({
            state: 'failed',
            reason: 'the sign-in exited with code 1',
            remedy: 'fy credential signin codex-you',
          }),
          linkAwaiting(),
        ]),
        submitSignInCode: () => ({ outcome: 'accepted', flow: codex({ state: 'complete' }) }),
      },
    });
    should(await runSignIn(world.deps, 'codex-you')).be.true();
    should(world.gateway.called('startSignIn').map(call => call.args[1])).eql([undefined, 'link']);
    should(world.out.text('warn')).match(/The device code did not work: the sign-in exited with code 1/);
    should(world.prompt.questions[0]).equal('Sign in with a link instead? [y/N]');
    should(world.out.exitCode).not.equal(1);
  });

  it('should report the device failure when the link is declined, and never offer one for a failed link', async () => {
    const failed = codex({ state: 'failed', reason: 'no', remedy: 'retry' });
    const declined = fakeWorld({ answers: [''], gateway: { startSignIn: () => failed } });
    should(await runSignIn(declined.deps, 'codex-you')).be.false();
    should(declined.out.text('error')).equal('Sign-in did not finish: no');
    should(declined.out.exitCode).equal(1);

    const link = fakeWorld({
      answers: ['http://localhost:1455/auth/callback?code=c&state=s'],
      gateway: {
        startSignIn: () => linkAwaiting(),
        submitSignInCode: () => ({ outcome: 'accepted', flow: failed }),
      },
    });
    should(await runSignIn(link.deps, 'codex-you')).be.false();
    should(link.prompt.questions).have.length(1);
  });

  it('should refuse a caller that needs a passkey confirmation, before any sign-in starts', async () => {
    const world = fakeWorld({
      gateway: {
        machine: () => machine({ authority: authorityOf({ mayApply: false, applyRefusal: 'step-up-required' }) }),
      },
    });
    await should(runSignIn(world.deps, 'claude-you')).be.rejectedWith(/passkey confirmation/);
    should(world.gateway.called('startSignIn')).be.empty();
  });
});
