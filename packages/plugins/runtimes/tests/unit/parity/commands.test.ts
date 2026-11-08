import { describe, expect, it } from 'bun:test';
import type { CliContext, PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import { instantFromEpochMs } from '@ferretry/std';
import cli from '../../../cli/index.ts';
import type { VERB_BODIES } from '../../../cli/lib/verbs.ts';
import manifest from '../../../manifest.ts';
import { ROUTES } from '../../../cli/lib/fleet/account-gateway.ts';
import { fakeWorld, modelSet, profile, runtime, runVerb } from '../cli/fleet/account-fakes.ts';

/**
 * The runtimes verbs (rows V-0182 … V-0395) against v4's command lines. Two renames are by design, not breaks:
 * `--credential <id>` is `--login <id>` (the word table: a sign-in is a login), and v4's one `fy component` command
 * is one verb per kind, so a model set (the one kind Runtimes owns) is `fy model-set …`.
 */
type Verb = keyof typeof VERB_BODIES;
type Options = VerbInvocation['options'];

const declared = new Set<string>(manifest.actions.cli.map(entry => entry.verb));

/** The cli half as the shell builds it, over a client that answers only the routes given. */
function half(answers: Readonly<Record<string, unknown>> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const client: PluginClient = {
    call: async <Answer>(route: string): Promise<Answer> => {
      if (!(route in answers)) throw new Error(`no answer for ${route}`);
      return answers[route] as Answer;
    },
    subscribe: () => () => undefined,
  };
  const ctx: CliContext<typeof manifest> = { manifest, client, io };
  const verbs = cli.build?.(ctx)?.verbs as Readonly<Record<string, (invocation: VerbInvocation) => Promise<number>>>;
  return { verbs, out, err };
}

/** A verb as v4's row names it: declared, bound in the half, and a missing name is a plain refusal, exit 1. */
async function declaredAndRefusesWithoutName(verb: Verb): Promise<void> {
  expect(declared.has(verb)).toBe(true);
  const { verbs, out, err } = half();
  expect(typeof verbs[verb]).toBe('function');
  expect(await verbs[verb]?.({ args: [], options: {} })).toBe(1);
  expect(out).toEqual([]);
  expect(err.join('')).toMatch(/^Say which /);
}

/** One write verb run to the end with `--yes`: the one change it staged, and that it then applied it. */
async function staged(verb: Verb, args: readonly string[], options: Options, gateway = {}) {
  const world = fakeWorld({ gateway });
  await runVerb(world, verb, args, { yes: true, ...options });
  expect(world.gateway.called('apply')).toHaveLength(1);
  expect(world.out.exitCode).toBeUndefined();
  return world.gateway.called('stage').map(call => call.args[0]);
}

const LISTS = {
  profiles: () => ({ format: 'present' as const, profiles: [profile({ name: 'work' })] }),
  runtimes: () => ({ format: 'present' as const, runtimes: [runtime({ name: 'claude-work', agent: true })] }),
  components: () => ({
    format: 'present' as const,
    kinds: [
      {
        kind: 'modelSets' as const,
        label: 'Model sets',
        description: 'the model choices a profile can layer in',
        components: [modelSet({ name: 'heavy' })],
      },
    ],
  }),
};

describe('commands parity: runtimes', () => {
  it('V-0395 fy runtimes lists the runtimes with --json, as the same body as `runtime ls`', async () => {
    expect(declared.has('runtimes')).toBe(true);
    const words = fakeWorld({ gateway: LISTS });
    await runVerb(words, 'runtimes');
    expect(words.out.text('report')).toMatch(/claude-work {2}Claude Code, agent/);
    const json = fakeWorld({ gateway: LISTS });
    await runVerb(json, 'runtimes', [], { json: true });
    expect(JSON.parse(json.out.text('report')).runtimes[0].name).toBe('claude-work');
    const { verbs, out } = half({
      [ROUTES.runtimes]: { format: 'present', runtimes: [] },
    });
    expect(await verbs.runtimes?.({ args: [], options: {} })).toBe(0);
    expect(out.join('')).toMatch(/No runtimes yet/);
  });

  it('V-0386 fy runtime is the group of every runtime verb, each declared under that first word', () => {
    const lines = [...declared].filter(line => line.startsWith('runtime '));
    expect(lines.sort()).toEqual(
      [
        'runtime add',
        'runtime disable',
        'runtime enable',
        'runtime link',
        'runtime ls',
        'runtime rename',
        'runtime rm',
        'runtime scan',
        'runtime set',
        'runtime show',
      ].sort(),
    );
    expect(declared.has('runtime')).toBe(false);
  });

  it('V-0387 fy runtime add <name> --login <id> --profile <name> --agent --add-another stages one new runtime', async () => {
    await declaredAndRefusesWithoutName('runtime add');
    expect(
      await staged('runtime add', ['claude-work'], {
        login: 'claude-you',
        profile: 'default',
        agent: true,
        'add-another': true,
      }),
    ).toEqual([
      {
        kind: 'runtime.put',
        name: 'claude-work',
        credential: 'claude-you',
        profile: 'default',
        agent: true,
        create: true,
        addAnother: true,
      },
    ]);
    await expect(runVerb(fakeWorld(), 'runtime add', ['x'], { profile: 'default' })).rejects.toThrow(/--login <id>/);
  });

  it('V-0394 fy runtime show <name> prints one runtime, or the plain refusal naming `runtime ls`, with --json', async () => {
    await declaredAndRefusesWithoutName('runtime show');
    const world = fakeWorld({ gateway: LISTS });
    await runVerb(world, 'runtime show', ['claude-work']);
    expect(world.out.text('report')).toMatch(/claude-work/);
    const json = fakeWorld({ gateway: LISTS });
    await runVerb(json, 'runtime show', ['claude-work'], { json: true });
    expect(JSON.parse(json.out.text('report')).name).toBe('claude-work');
    const { verbs, err } = half({ [ROUTES.runtimes]: { format: 'present', runtimes: [] } });
    expect(await verbs['runtime show']?.({ args: ['nope'], options: {} })).toBe(1);
    expect(err.join('')).toMatch(/There is no runtime called "nope"\. See them all with `fy runtime ls`\./);
  });

  it('V-0393 fy runtime set <name> --login --profile --agent/--no-agent changes the one named, and needs one of them', async () => {
    await declaredAndRefusesWithoutName('runtime set');
    const gateway = LISTS;
    expect(
      await staged('runtime set', ['claude-work'], { login: 'other', profile: 'work', agent: false }, gateway),
    ).toEqual([
      { kind: 'runtime.put', name: 'claude-work', credential: 'other', profile: 'work', agent: false, create: false },
    ]);
    await expect(runVerb(fakeWorld({ gateway }), 'runtime set', ['claude-work'])).rejects.toThrow(
      /--agent or --no-agent/,
    );
  });

  it('V-0388 fy runtime disable <name> --reason <text> --until <when> stages a switch-off that running ferrets outlive', async () => {
    await declaredAndRefusesWithoutName('runtime disable');
    expect(await staged('runtime disable', ['claude-work'], { reason: 'quota', until: '2030-01-01' }, LISTS)).toEqual([
      {
        kind: 'runtime.disable',
        name: 'claude-work',
        reason: 'quota',
        until: instantFromEpochMs(Date.parse('2030-01-01T00:00:00Z')),
      },
    ]);
    expect(await staged('runtime disable', ['claude-work'], {}, LISTS)).toEqual([
      { kind: 'runtime.disable', name: 'claude-work' },
    ]);
  });

  it('V-0389 fy runtime enable <name> stages the switch back on, and --dry-run applies nothing', async () => {
    await declaredAndRefusesWithoutName('runtime enable');
    expect(await staged('runtime enable', ['claude-work'], {}, LISTS)).toEqual([
      { kind: 'runtime.enable', name: 'claude-work' },
    ]);
    const dry = fakeWorld({ gateway: LISTS });
    await runVerb(dry, 'runtime enable', ['claude-work'], { 'dry-run': true });
    expect(dry.gateway.called('apply')).toEqual([]);
    expect(dry.out.text('report')).toMatch(/Dry run: nothing was changed\./);
  });

  it('V-0391 fy runtime rename <name> <new-name> stages the rename, and needs both names', async () => {
    await declaredAndRefusesWithoutName('runtime rename');
    expect(await staged('runtime rename', ['claude-work', 'claude-job'], {})).toEqual([
      { kind: 'runtime.rename', name: 'claude-work', to: 'claude-job' },
    ]);
    await expect(runVerb(fakeWorld(), 'runtime rename', ['claude-work'])).rejects.toThrow(/new name it gets/);
  });

  it('V-0392 fy runtime rm <name> stages the removal, and stops without --yes off a terminal with exit 1', async () => {
    await declaredAndRefusesWithoutName('runtime rm');
    expect(await staged('runtime rm', ['claude-work'], {})).toEqual([{ kind: 'runtime.remove', name: 'claude-work' }]);
    const world = fakeWorld({ interactive: false });
    await runVerb(world, 'runtime rm', ['claude-work']);
    expect(world.out.exitCode).toBe(1);
    expect(world.gateway.called('apply')).toEqual([]);
    expect(world.out.text('error')).toMatch(/Re-run with --yes/);
  });
});

describe('commands parity: profiles', () => {
  it('V-0360 fy profiles lists the profiles with --json, as the same body as `profile ls`', async () => {
    expect(declared.has('profiles')).toBe(true);
    const words = fakeWorld({ gateway: LISTS });
    await runVerb(words, 'profiles');
    expect(words.out.text('report')).toMatch(/work {2}Generic · 1 layer\n {2}Used by: claude-default/);
    const json = fakeWorld({ gateway: LISTS });
    await runVerb(json, 'profiles', [], { json: true });
    expect(JSON.parse(json.out.text('report')).profiles[0].name).toBe('work');
    const { verbs, out } = half({ [ROUTES.profiles]: { format: 'present', profiles: [] } });
    expect(await verbs.profiles?.({ args: [], options: {} })).toBe(0);
    expect(out.join('')).toMatch(/No profiles yet/);
  });

  it('V-0352 fy profile is the group of every profile verb, each declared under that first word', () => {
    expect([...declared].filter(line => line.startsWith('profile ')).sort()).toEqual(
      ['profile build', 'profile edit', 'profile ls', 'profile rm', 'profile show'].sort(),
    );
    expect(declared.has('profile')).toBe(false);
  });

  it('V-0356 fy profile ls lists each profile with its scope, as words or --json', async () => {
    expect(declared.has('profile ls')).toBe(true);
    const words = fakeWorld({ gateway: LISTS });
    await runVerb(words, 'profile ls');
    expect(words.out.text('report')).toMatch(/work {2}Generic/);
    const json = fakeWorld({ gateway: LISTS });
    await runVerb(json, 'profile ls', [], { json: true });
    expect(JSON.parse(json.out.text('report')).profiles).toHaveLength(1);
  });

  it('V-0359 fy profile show <name> prints its layers, overrides and use, --json, and refuses an unknown name', async () => {
    await declaredAndRefusesWithoutName('profile show');
    const words = fakeWorld({ gateway: LISTS });
    await runVerb(words, 'profile show', ['work']);
    expect(words.out.text('report')).toMatch(/Layers, oldest first/);
    expect(words.out.text('report')).toMatch(/Used by: claude-default/);
    const json = fakeWorld({ gateway: LISTS });
    await runVerb(json, 'profile show', ['work'], { json: true });
    expect(JSON.parse(json.out.text('report')).name).toBe('work');
    const { verbs, err } = half({ [ROUTES.profiles]: { format: 'present', profiles: [] } });
    expect(await verbs['profile show']?.({ args: ['nope'], options: {} })).toBe(1);
    expect(err.join('')).toMatch(/There is no profile called "nope"\. See them all with `fy profile ls`\./);
  });

  it('V-0353 fy profile build <name> --layer <kind/name> (repeatable) stages a new profile, layers oldest first', async () => {
    await declaredAndRefusesWithoutName('profile build');
    expect(await staged('profile build', ['work'], { layer: ['instructions/main', 'profile/base'] })).toEqual([
      { kind: 'profile.put', name: 'work', layers: ['instructions/main', 'profile/base'], create: true },
    ]);
    await expect(runVerb(fakeWorld(), 'profile build', ['work'])).rejects.toThrow(
      /A profile needs at least one layer: --layer/,
    );
  });

  it('V-0354 fy profile edit <name> --layer <kind/name> replaces the layers, and a --dry-run applies nothing', async () => {
    await declaredAndRefusesWithoutName('profile edit');
    expect(await staged('profile edit', ['work'], { layer: 'instructions/main' })).toEqual([
      { kind: 'profile.put', name: 'work', layers: ['instructions/main'], create: false },
    ]);
    const dry = fakeWorld();
    await runVerb(dry, 'profile edit', ['work'], { layer: 'instructions/main', 'dry-run': true, json: true });
    expect(dry.gateway.called('apply')).toEqual([]);
    expect(JSON.parse(dry.out.text('report')).change.id).toBeString();
  });

  it('V-0358 fy profile rm <name> --switch-runtimes-to <profile> stages the removal, and the switch is optional', async () => {
    await declaredAndRefusesWithoutName('profile rm');
    expect(await staged('profile rm', ['work'], { 'switch-runtimes-to': 'default' })).toEqual([
      { kind: 'profile.remove', name: 'work', switchRuntimesTo: 'default' },
    ]);
    expect(await staged('profile rm', ['work'], {})).toEqual([{ kind: 'profile.remove', name: 'work' }]);
  });
});

describe('commands parity: components (a model set is the kind Runtimes owns, `fy model-set …`)', () => {
  const heavy = { kind: 'modelSets', models: ['opus', 'sonnet'], default: 'opus' };

  it('V-0182 fy component is one verb per kind: the model-set group, each declared under that first word', () => {
    expect([...declared].filter(line => line.startsWith('model-set ')).sort()).toEqual(
      ['model-set add', 'model-set edit', 'model-set ls', 'model-set rm', 'model-set show'].sort(),
    );
    expect(declared.has('component')).toBe(false);
  });

  it('V-0183 fy component add <kind/name> --model <id> --default <id> becomes `model-set add`, staging a new model set', async () => {
    await declaredAndRefusesWithoutName('model-set add');
    expect(await staged('model-set add', ['heavy'], { model: ['opus', 'sonnet'], default: 'opus' })).toEqual([
      { kind: 'component.put', name: 'heavy', component: heavy, create: true },
    ]);
    await expect(runVerb(fakeWorld(), 'model-set add', ['heavy'])).rejects.toThrow(/needs at least one --model <id>/);
  });

  it('V-0184 fy component edit <kind/name> becomes `model-set edit`, keeping what a flag leaves out and changing every user', async () => {
    await declaredAndRefusesWithoutName('model-set edit');
    expect(await staged('model-set edit', ['heavy'], { default: 'sonnet' }, LISTS)).toEqual([
      { kind: 'component.put', name: 'heavy', component: { ...heavy, default: 'sonnet' }, create: false },
    ]);
    await expect(runVerb(fakeWorld(), 'model-set edit', ['heavy'], { model: 'opus' })).rejects.toThrow(
      /There is no model set heavy to change/,
    );
  });

  it('V-0186 fy component rm <kind/name> --remove-from-profiles becomes `model-set rm`, refused while a profile uses it unless told', async () => {
    await declaredAndRefusesWithoutName('model-set rm');
    expect(await staged('model-set rm', ['heavy'], { 'remove-from-profiles': true })).toEqual([
      { kind: 'component.remove', componentKind: 'modelSets', name: 'heavy', removeFromProfiles: true },
    ]);
    expect(await staged('model-set rm', ['heavy'], {})).toEqual([
      { kind: 'component.remove', componentKind: 'modelSets', name: 'heavy' },
    ]);
  });

  it('V-0187 fy component show <kind/name> becomes `model-set show`: one model set and where it is used, --json', async () => {
    await declaredAndRefusesWithoutName('model-set show');
    const words = fakeWorld({ gateway: LISTS });
    await runVerb(words, 'model-set show', ['heavy']);
    expect(words.out.text('report')).toMatch(/Models: opus, sonnet/);
    expect(words.out.text('report')).toMatch(/Used by profiles: default/);
    const json = fakeWorld({ gateway: LISTS });
    await runVerb(json, 'model-set show', ['heavy'], { json: true });
    expect(JSON.parse(json.out.text('report')).reference).toBe('modelSets/heavy');
    const { verbs, err } = half({ [ROUTES.components]: { format: 'present', kinds: [] } });
    expect(await verbs['model-set show']?.({ args: ['nope'], options: {} })).toBe(1);
    expect(err.join('')).toMatch(/There is no model set called "nope"\. See them all with `fy model-set ls`\./);
  });
});
