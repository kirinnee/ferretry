import { describe, it } from 'bun:test';
import { instantFromEpochMs } from '@ferretry/std';
import should from 'should';
import { renderRuntime, renderRuntimeList } from '../../../../cli/lib/runtime/render.ts';
import { fakeWorld, runtime, runVerb, stack } from '../fleet/account-fakes.ts';

const agent = runtime({
  name: 'claude-agent',
  agent: true,
  credential: { id: 'claude-you', store: 'host', label: 'mine' },
  stack: stack({
    available: { available: false, reason: 'Some layers do not apply.' },
    skipped: [{ reference: 'settings/codex', sentence: 'settings/codex is for Codex.' }],
    partial: [{ reference: 'mcp/x', reason: 'no env' }],
    conflicts: [
      {
        harness: 'claude-code',
        field: 'settings',
        key: 'model',
        sentence: 'model: b overrides a',
        winner: 'b',
        overridden: ['a'],
      },
    ],
  }),
  modelSet: {
    source: 'model-set',
    name: 'heavy',
    models: [
      { id: 'opus', available: true },
      { id: 'mythos', available: false },
    ],
    declaredDefault: 'mythos',
    default: 'opus',
    note: 'The default moved to opus.',
  },
  fixedLayer: {
    agentPermissions: 'auto',
    entries: [{ key: '--permission-mode', value: 'auto' }],
    overridden: [
      { key: 'permissions.defaultMode', value: 'plan', from: 'default', sentence: 'plan from default is replaced.' },
    ],
  },
  launch: { available: false, reason: 'Sign in to launch' },
  sameAs: ['claude-agent-2'],
});

describe('runtime renderings', () => {
  it('should list runtimes with their login, profile and whether they launch', () => {
    const text = renderRuntimeList({ format: 'present', runtimes: [runtime(), agent] }, 'fz');
    should(text).match(
      /claude-default {2}Claude Code {2}— ready to launch\n {2}Login: claude-you \(needs sign in\) · Profile: default/,
    );
    should(text).match(/claude-agent {2}Claude Code, agent {2}— Sign in to launch\n {2}Login: mine ·/);
  });

  it('should say how to get a first runtime', () => {
    should(renderRuntimeList({ format: 'none', runtimes: [] }, 'fz'))
      .match(/fz onboard/)
      .and.match(/fz runtime add/);
  });

  it('should show the stack, models and the fixed layer of an agent runtime', () => {
    const text = renderRuntime(agent);
    should(text).match(/Some layers do not apply\./);
    should(text).match(/Skipped: settings\/codex is for Codex\./);
    should(text).match(/Partly supported: mcp\/x — no env/);
    should(text).match(/Overrides: model: b overrides a/);
    should(text).match(/Models \(heavy\): opus, mythos \(not available on this login\)/);
    should(text)
      .match(/Starts with: opus/)
      .and.match(/The default moved to opus\./);
    should(text)
      .match(/--permission-mode = auto/)
      .and.match(/plan from default is replaced\./);
    should(text).match(/Same login and profile as: claude-agent-2/);
  });

  it('should say when no model can start, and when it uses the tool default', () => {
    const none = renderRuntime(
      runtime({
        modelSet: { source: 'model-set', name: 's', models: [{ id: 'x', available: false }], declaredDefault: 'x' },
      }),
    );
    should(none).match(/none of them is available on this login/);
    should(renderRuntime(runtime())).match(/Models: the Claude Code default/);
  });
});

describe('runtime verbs', () => {
  it('should list runtimes, as words or JSON', async () => {
    const world = fakeWorld({ gateway: { runtimes: () => ({ format: 'present', runtimes: [runtime()] }) } });
    await runVerb(world, 'runtime ls');
    await runVerb(world, 'runtime ls', [], { json: true });
    should(world.out.lines[0]?.text).match(/claude-default/);
    should(JSON.parse(world.out.lines[1]?.text as string).runtimes).have.length(1);
  });

  it('should add a runtime without asking', async () => {
    const world = fakeWorld();
    await runVerb(world, 'runtime add', ['claude-agent'], {
      login: 'claude-you',
      profile: 'default',
      agent: true,
      'add-another': true,
    });
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'runtime.put',
      name: 'claude-agent',
      credential: 'claude-you',
      profile: 'default',
      agent: true,
      create: true,
      addAnother: true,
    });
    should(world.prompt.questions).be.empty();

    const plain = fakeWorld();
    await runVerb(plain, 'runtime add', ['x'], { login: 'c', profile: 'p' });
    should(plain.gateway.called('stage')[0]?.args[0]).match({ agent: false, create: true });
  });

  it('should refuse an add that does not say which login and profile', async () => {
    const world = fakeWorld();
    await should(runVerb(world, 'runtime add', ['x'], { profile: 'p' })).be.rejectedWith(/--login/);
    await should(runVerb(world, 'runtime add', ['x'], { login: 'c' })).be.rejectedWith(/--profile/);
    await should(runVerb(world, 'runtime add', [], { login: 'c', profile: 'p' })).be.rejectedWith(/Say which runtime/);
    should(world.gateway.called('stage')).be.empty();
  });

  it('should show one runtime, or refuse a name it does not have', async () => {
    const world = fakeWorld({ gateway: { runtimes: () => ({ format: 'present', runtimes: [runtime()] }) } });
    await runVerb(world, 'runtime show', ['claude-default']);
    await runVerb(world, 'runtime show', ['claude-default'], { json: true });
    should(world.out.lines[0]?.text).match(/^claude-default {2}Claude Code/);
    should(JSON.parse(world.out.lines[1]?.text as string).name).equal('claude-default');
    await should(runVerb(world, 'runtime show', ['nope'])).be.rejectedWith(/fz runtime ls/);
  });

  it('should change only what was named, after a yes', async () => {
    const world = fakeWorld({
      answers: ['y', 'y'],
      gateway: { runtimes: () => ({ format: 'present', runtimes: [runtime()] }) },
    });
    await runVerb(world, 'runtime set', ['claude-default'], { agent: true });
    await runVerb(world, 'runtime set', ['claude-default'], { login: 'c2', profile: 'p2', agent: false });
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      {
        kind: 'runtime.put',
        name: 'claude-default',
        credential: 'claude-you',
        profile: 'default',
        agent: true,
        create: false,
      },
      { kind: 'runtime.put', name: 'claude-default', credential: 'c2', profile: 'p2', agent: false, create: false },
    ]);
    await should(runVerb(world, 'runtime set', ['claude-default'])).be.rejectedWith(/Say what to change/);
  });

  it('should remove a runtime under --yes', async () => {
    const world = fakeWorld({ interactive: false });
    await runVerb(world, 'runtime rm', ['old'], { yes: true });
    should(world.gateway.called('stage')[0]?.args[0]).eql({ kind: 'runtime.remove', name: 'old' });
    should(world.gateway.called('apply')).have.length(1);
  });

  it('should read -y as --yes', async () => {
    const world = fakeWorld({ interactive: false });
    await runVerb(world, 'runtime rm', ['old'], { y: true });
    should(world.gateway.called('apply')).have.length(1);
  });

  it('should rename a runtime under --yes, and stop at a dry run', async () => {
    const world = fakeWorld({ interactive: false });
    await runVerb(world, 'runtime rename', ['old', 'new'], { yes: true });
    should(world.gateway.called('stage')[0]?.args[0]).eql({ kind: 'runtime.rename', name: 'old', to: 'new' });
    should(world.gateway.called('apply')).have.length(1);

    const dry = fakeWorld({ interactive: false });
    await runVerb(dry, 'runtime rename', ['old', 'new'], { 'dry-run': true });
    should(dry.gateway.called('stage')).have.length(1);
    should(dry.gateway.called('apply')).have.length(0);
  });

  it('should ask before renaming, and change nothing off a terminal without --yes', async () => {
    const world = fakeWorld({ interactive: false });
    await runVerb(world, 'runtime rename', ['old', 'new']);
    should(world.gateway.called('apply')).have.length(0);
    should(world.out.exitCode).equal(1);
    should(world.out.text('error')).match(/Re-run with --yes/);
  });
});

describe('runtime disable and enable', () => {
  const known = { gateway: { runtimes: () => ({ format: 'present' as const, runtimes: [runtime()] }) } };

  it('should switch a runtime off with a reason and a date, without asking', async () => {
    const world = fakeWorld(known);
    await runVerb(world, 'runtime disable', ['claude-default'], { until: '2026-11-01', reason: 'spend limit' });
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'runtime.disable',
      name: 'claude-default',
      reason: 'spend limit',
      until: '2026-11-01T00:00:00.000Z',
    });
    should(world.prompt.questions).be.empty();
  });

  it('should switch it off for good when no end is given', async () => {
    const world = fakeWorld(known);
    await runVerb(world, 'runtime disable', ['claude-default']);
    should(world.gateway.called('stage')[0]?.args[0]).eql({ kind: 'runtime.disable', name: 'claude-default' });
  });

  it('should switch it back on', async () => {
    const world = fakeWorld(known);
    await runVerb(world, 'runtime enable', ['claude-default']);
    should(world.gateway.called('stage')[0]?.args[0]).eql({ kind: 'runtime.enable', name: 'claude-default' });
    should(world.prompt.questions).be.empty();
  });

  it('should refuse a runtime it does not have, and an end already passed', async () => {
    const world = fakeWorld(known);
    await should(runVerb(world, 'runtime disable', ['nope'])).be.rejectedWith(/fz runtime ls/);
    await should(runVerb(world, 'runtime enable', ['nope'])).be.rejectedWith(/fz runtime ls/);
    await should(runVerb(world, 'runtime disable', ['claude-default'], { until: '2020-01-01' })).be.rejectedWith(
      /already passed/,
    );
    should(world.gateway.called('stage')).be.empty();
  });
});

describe('runtime renderings of a switched-off runtime', () => {
  const off = runtime({
    launch: { available: false, reason: 'runtime "claude-default" is disabled.' },
    disabled: {
      reason: 'spend limit',
      until: instantFromEpochMs(Date.parse('2026-11-01T00:00:00.000Z')),
      source: 'login',
    },
  });

  it('should say it is disabled, why and until when, in the list and on the page', () => {
    should(renderRuntimeList({ format: 'present', runtimes: [off] }, 'fz')).match(
      /claude-default {2}Claude Code {2}— disabled \(spend limit\) until 2026-11-01\n/,
    );
    should(renderRuntime(off)).match(/Switch: disabled \(spend limit\) until 2026-11-01 \(on its login\)/);
  });
});
