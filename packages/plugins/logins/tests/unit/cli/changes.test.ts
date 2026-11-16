import { describe, it } from 'bun:test';
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import should from 'should';
import { authorityOf, REFUSALS } from '../../../cli/lib/authority.ts';
import { parseUntil } from '../../../cli/lib/change.ts';
import {
  loginAdd,
  loginCheck,
  loginDisable,
  loginEnable,
  loginLabel,
  loginRm,
  loginSignout,
  loginTest,
  suggestLoginId,
} from '../../../cli/lib/commands.ts';
import { LoginsCommandError } from '../../../cli/lib/ports.ts';
import type { LoginChangeOutcome, LoginChangeView } from '../../../contract/index.ts';
import { fakeWorld, flow, login, loginList } from './fakes.ts';

const inv = (args: string[], options: VerbInvocation['options'] = {}): VerbInvocation => ({ args, options });
const view = (summary = 'Do it', consequences: string[] = []): LoginChangeView =>
  ({
    id: 'chg1',
    change: { kind: 'login.enable', id: 'work' },
    summary,
    consequences,
    expiresAt: '2026-11-01T10:15:00.000Z',
    state: 'pending',
  }) as unknown as LoginChangeView;
const applied: LoginChangeOutcome = { outcome: 'applied' };

describe('who may change the machine (the pre-check every change and sign-in makes)', () => {
  it('should read the fleet row of the grants: allowed, step-up, a reason, and never "allowed" when it cannot tell', () => {
    const grants = (row?: { configure: boolean; configureRefusal: string }) => ({
      capabilities: row === undefined ? [] : [{ capability: 'fleet', ...row }],
    });
    should(authorityOf(grants({ configure: true, configureRefusal: 'granted' }))).eql({
      mayApply: true,
      applyRefusal: 'granted',
    });
    should(authorityOf(grants({ configure: false, configureRefusal: 'step-up-required' }))).eql({
      mayApply: false,
      applyRefusal: 'step-up-required',
    });
    should(authorityOf(grants())).eql({ mayApply: false, applyRefusal: 'undetermined' });
    should(authorityOf('nonsense')).eql({ mayApply: false, applyRefusal: 'undetermined' });
  });

  it('should refuse each reason in its own words before anything is staged, checked or tested', async () => {
    for (const refusal of ['not-granted', 'device-not-granted', 'step-up-required', 'undetermined'] as const) {
      const world = fakeWorld({ gateway: { authority: () => ({ mayApply: false, applyRefusal: refusal }) } });

      for (const run of [
        () => loginEnable(world.deps, inv(['work'])),
        () => loginCheck(world.deps, inv(['work'])),
        () => loginTest(world.deps, inv(['work'])),
      ]) {
        const error = (await run().catch(caught => caught)) as LoginsCommandError;
        should(error).be.instanceOf(LoginsCommandError);
        should(error.message).equal(REFUSALS[refusal]);
      }
      should(world.gateway.called('stage')).be.empty();
      should(world.gateway.called('check')).be.empty();
      should(world.gateway.called('test')).be.empty();
    }
  });

  it('should say a command line cannot give a passkey and what to do instead', () => {
    should(REFUSALS['step-up-required']).equal(
      'This change needs a passkey confirmation from a paired device, which a command line cannot give. Make it from the app, or run this on the machine itself.',
    );
  });
});

describe('the change verbs', () => {
  it('should stage, show, and apply a switch-on without asking, since it removes nothing', async () => {
    const world = fakeWorld({ gateway: { stage: () => view('Enable login work'), apply: () => applied } });

    await loginEnable(world.deps, inv(['work']));

    should(world.gateway.called('stage')[0]?.args).eql([{ kind: 'login.enable', id: 'work' }]);
    should(world.gateway.called('apply')[0]?.args).eql(['chg1']);
    should(world.out.text('report')).equal('Enable login work');
    should(world.out.text('success')).equal('Done.');
    should(world.prompt.questions).eql([]);
  });

  it('should disable with a reason and a wait counted from now', async () => {
    const world = fakeWorld({ gateway: { stage: () => view(), apply: () => applied } });

    await loginDisable(world.deps, inv(['work'], { reason: ' over budget ', until: '2d' }));

    should(world.gateway.called('stage')[0]?.args).eql([
      { kind: 'login.disable', id: 'work', reason: 'over budget', until: '2026-11-03T10:00:00.000Z' },
    ]);
  });

  it('should label, and clear the label with --clear, and refuse a blank label', async () => {
    const world = fakeWorld({ gateway: { stage: () => view(), apply: () => applied } });

    await loginLabel(world.deps, inv(['work', 'Work']));
    await loginLabel(world.deps, inv(['work'], { clear: true }));

    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      { kind: 'login.label', id: 'work', label: 'Work' },
      { kind: 'login.label', id: 'work', label: null },
    ]);
    await should(loginLabel(world.deps, inv(['work']))).be.rejectedWith(/Name the label, or pass --clear/);
  });

  it('should ask before a sign-out or removal, and do nothing on "no"', async () => {
    const world = fakeWorld({ answers: ['n'], gateway: { stage: () => view(), apply: () => applied } });

    await loginRm(world.deps, inv(['work']));

    should(world.prompt.questions).eql(['Go ahead? [y/N]']);
    should(world.gateway.called('apply')).be.empty();
    should(world.out.exitCode).equal(1);
    should(world.out.text('warn')).equal('Nothing was changed.');
  });

  it('should go ahead on --yes, and refuse off a terminal without it', async () => {
    const yes = fakeWorld({ gateway: { stage: () => view(), apply: () => applied } });
    await loginSignout(yes.deps, inv(['work'], { yes: true }));
    should(yes.gateway.called('apply')).have.length(1);

    const script = fakeWorld({ interactive: false, gateway: { stage: () => view(), apply: () => applied } });
    await loginRm(script.deps, inv(['work']));
    should(script.gateway.called('apply')).be.empty();
    should(script.out.exitCode).equal(1);
    should(script.out.text('error')).startWith('Nothing was changed: this needs a yes.');
  });

  it('should change nothing on --dry-run, in JSON when asked', async () => {
    const world = fakeWorld({ gateway: { stage: () => view('Remove login work'), apply: () => applied } });

    await loginRm(world.deps, inv(['work'], { 'dry-run': true }));
    await loginEnable(world.deps, inv(['work'], { 'dry-run': true, json: true }));

    should(world.gateway.called('apply')).be.empty();
    should(world.out.text('report')).containEql('Dry run: nothing was changed.');
    should(JSON.parse(world.out.lines.at(-1)?.text ?? '{}').change.id).equal('chg1');
  });

  it('should say a failed sign-out failed, with a non-zero exit, and a held change as held', async () => {
    const failed = fakeWorld({
      gateway: {
        stage: () => view(),
        apply: () => ({ outcome: 'sign-out-failed', reason: 'the harness could not sign out', login: login() }),
      },
    });
    await loginSignout(failed.deps, inv(['claude-you'], { yes: true }));
    should(failed.out.text('error')).equal('Could not sign out claude-you: the harness could not sign out');
    should(failed.out.exitCode).equal(1);

    const held = fakeWorld({
      gateway: { stage: () => view(), apply: () => ({ outcome: 'held', sentences: ['a daily limit is removed'] }) },
    });
    await loginRm(held.deps, inv(['work'], { yes: true }));
    should(held.out.text('success')).containEql('the owner has to confirm it');
    should(held.out.text('success')).containEql('a daily limit is removed');
    should(held.out.exitCode).equal(0);
  });

  it('should not name the app as a place to do this', async () => {
    const world = fakeWorld({ gateway: { stage: () => view(), apply: () => applied } });
    await loginEnable(world.deps, inv(['work']));
    should(world.out.lines.map(line => line.text).join('\n')).not.containEql('Use the app');
  });
});

describe('login add', () => {
  const taken = loginList(login({ id: 'claude-login' }));

  it('should add a sign-in with a free id, then sign it in', async () => {
    const world = fakeWorld({
      gateway: {
        logins: () => taken,
        stage: () => view('Add a Claude Code login'),
        apply: () => applied,
        startSignIn: () => flow({ state: 'complete' }),
        signInStatus: () => flow({ state: 'complete' }),
      },
    });

    await loginAdd(world.deps, inv(['claude']));

    should(world.gateway.called('stage')[0]?.args).eql([
      { kind: 'login.add', id: 'claude-login-2', harness: 'claude-code' },
    ]);
    should(world.gateway.called('startSignIn')[0]?.args[0]).equal('claude-login-2');
  });

  it('should add without signing in when told, and name the way back', async () => {
    const world = fakeWorld({
      gateway: { logins: () => loginList(), stage: () => view(), apply: () => applied },
    });

    await loginAdd(world.deps, inv(['codex'], { label: 'Team', 'no-sign-in': true }));

    should(world.gateway.called('stage')[0]?.args).eql([
      { kind: 'login.add', id: 'codex-team', harness: 'codex', label: 'Team' },
    ]);
    should(world.gateway.called('startSignIn')).be.empty();
    should(world.out.text('report')).containEql('Sign it in when you are ready: fz login signin codex-team');
  });

  it('should make an environment login from a preset, each secret a reference and never a value', async () => {
    const preset = {
      id: 'openai-api-key',
      label: 'OpenAI API key',
      harness: 'codex',
      offered: { available: true },
      halves: [{ harness: 'codex', offered: { available: true }, models: [] }],
      variables: [{ name: 'OPENAI_API_KEY', kind: 'secret', secret: 'OPENAI_API_KEY' }],
    };
    const world = fakeWorld({
      gateway: {
        logins: () => loginList(),
        presets: () => ({ presets: [preset] }) as never,
        stage: () => view(),
        apply: () => applied,
      },
    });

    await loginAdd(world.deps, inv(['codex'], { preset: 'openai-api-key' }));

    should(world.gateway.called('stage')[0]?.args).eql([
      {
        kind: 'login.add',
        id: 'codex-openai-api-key',
        harness: 'codex',
        store: 'environment',
        preset: 'openai-api-key',
        env: { OPENAI_API_KEY: '${secret:OPENAI_API_KEY}' },
      },
    ]);
    should(world.out.text('report')).containEql('Store each secret it names with `fz secret set NAME`');
    should(world.gateway.called('startSignIn')).be.empty();
  });

  it('should refuse an unknown tool or provider by name', async () => {
    const world = fakeWorld({ gateway: { logins: () => loginList(), presets: () => ({ presets: [] }) } });

    await should(loginAdd(world.deps, inv(['nonesuch']))).be.rejectedWith(
      'There is no provider "nonesuch": see `fz login presets`',
    );
  });

  it('should suggest ids that are free', () => {
    should(suggestLoginId('claude-code', undefined, new Set())).equal('claude-login');
    should(suggestLoginId('codex', 'My Team!', new Set(['codex-my-team']))).equal('codex-my-team-2');
  });
});

describe('parseUntil', () => {
  const NOW = Date.parse('2026-11-01T10:00:00Z');
  it('should read a date, a time and a wait, and refuse a past or unreadable one', () => {
    should(parseUntil('2026-11-05', NOW)).equal('2026-11-05T00:00:00.000Z');
    should(parseUntil('12h', NOW)).equal('2026-11-01T22:00:00.000Z');
    should(() => parseUntil('2026-10-01', NOW)).throw(/already passed/);
    should(() => parseUntil('soon', NOW)).throw(/not a time I can read/);
  });
});
