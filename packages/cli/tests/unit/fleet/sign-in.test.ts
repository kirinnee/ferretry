import { describe, it } from 'bun:test';
import should from 'should';
import { runSignIn, SIGN_IN_POLL_MS } from '../../../src/lib/fleet/sign-in.ts';
import { fakeWorld, flow, LATER, permissions } from './account-fakes.ts';

const URL = 'https://claude.ai/oauth/authorize?code=true';
const awaitingCode = (extra: Record<string, unknown> = {}) =>
  flow({ state: 'awaiting-code', verificationUrl: URL, ...extra });
const complete = () => flow({ state: 'complete', accounts: [] });

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
    should(world.gateway.called('submitSignInCode')[0]?.args).eql(['flow-1', 'the-code', {}]);
    should(world.prompt.questions).eql(['Paste the code the page shows:']);
    should(world.out.text('report')).equal(`Open this page and sign in:\n  ${URL}`);
    should(world.out.text('success')).equal('Signed in. claude-you is ready to use.');
    should(world.slept.every(ms => ms === SIGN_IN_POLL_MS)).be.true();
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

  it('should carry the operator password a caller off this machine owes', async () => {
    const world = fakeWorld({ gateway: { permissions: () => permissions({ confirmation: 'operator-password' }) } });
    await runSignIn(world.deps, 'claude-you');
    should(world.gateway.called('startSignIn')[0]?.args).eql(['claude-you', { password: 'operator-password-1' }]);
  });
});
