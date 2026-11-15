import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { describe, expect, test } from 'bun:test';
import { AGENT_CONTROL_KINDS, AgentControlPort, type AgentControlKind } from '@ferretry/kernel/contract';
import {
  type AgentControl,
  DEFAULT_AGENT_CONTROL,
  NO_AGENT_CONTROL,
  type FerretId,
  type FerretRecord,
} from '../../../../contract/index.ts';
import { ok, err } from '@ferretry/std';
import {
  FakeHarness,
  FakeRunner,
  emptyChildEnvironment,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';
import {
  type LaunchEnvironmentRecord,
  LaunchEnvironmentStore,
  modeSwitchDefaults,
  recordedSwitches,
  sessionModeSwitch,
  switchesOfRecord,
} from '../../../../daemon/lib/agent-control/launch-environment.ts';
import { instructionsAnswer } from '../../../../daemon/lib/agent-control/instructions.ts';
import { agentControlReader, SWITCH_OF_KIND } from '../../../../daemon/lib/agent-control/reader.ts';
import manifest from '../../../../manifest.ts';

const wren = 'wren' as FerretId;

/** A switch document with exactly `on` on. Fake: no `limits.yaml`. */
const only = (...on: readonly (keyof AgentControl)[]): AgentControl => ({
  terminals: on.includes('terminals'),
  browsers: on.includes('browsers'),
  files: on.includes('files'),
  ferretrySettings: on.includes('ferretrySettings'),
  pageScripts: on.includes('pageScripts'),
});

describe('AgentControlPort: ONE reader of "What agents may control", for every kind', () => {
  test('R-0244 Ferrets provides the kernel-bound agent-control port', () => {
    expect(AgentControlPort.name).toBe('agent-control');
    expect(manifest.provides).toMatchObject({ agentControl: AgentControlPort });
  });

  test('R-0244 the kinds are today’s five, as a closed list, each answered by its own switch', () => {
    expect([...AGENT_CONTROL_KINDS]).toEqual(['terminal', 'browser', 'files', 'settings', 'scripts']);
    expect(SWITCH_OF_KIND).toEqual({
      terminal: 'terminals',
      browser: 'browsers',
      files: 'files',
      settings: 'ferretrySettings',
      scripts: 'pageScripts',
    });
  });

  for (const kind of AGENT_CONTROL_KINDS) {
    test(`R-0244 kind ${kind}: on → allowed, off → refused, and no other switch answers for it`, async () => {
      const own = SWITCH_OF_KIND[kind];
      const on = agentControlReader(async () => only(own));
      const off = agentControlReader(async () =>
        only(...(Object.values(SWITCH_OF_KIND).filter(switchName => switchName !== own) as (keyof AgentControl)[])),
      );
      expect(await on.allows(wren, kind)).toBe(true);
      expect(await off.allows(wren, kind)).toBe(false);
    });
  }

  test('R-0244 read fresh every call: a change applies to the very next act', async () => {
    let current = only();
    const reader = agentControlReader(async () => current);
    expect(await reader.allows(wren, 'settings')).toBe(false);
    current = only('ferretrySettings');
    expect(await reader.allows(wren, 'settings')).toBe(true);
  });

  test('R-0244 today’s defaults: terminals, browsers and files on; Ferretry settings and page scripts off; an unknown ferret controls nothing', async () => {
    const defaults = agentControlReader(async () => DEFAULT_AGENT_CONTROL);
    const answers: Record<AgentControlKind, boolean> = {
      terminal: true,
      browser: true,
      files: true,
      settings: false,
      scripts: false,
    };
    for (const kind of AGENT_CONTROL_KINDS) expect(await defaults.allows(wren, kind)).toBe(answers[kind]);
    const unknown = agentControlReader(async () => NO_AGENT_CONTROL);
    for (const kind of AGENT_CONTROL_KINDS) expect(await unknown.allows(wren, kind)).toBe(false);
  });
});

describe('instructions', () => {
  test('T-0036 the tool is declared with today’s name and words, for any authenticated caller', () => {
    const declared = manifest.actions?.agentTools?.find(tool => tool.name === 'instructions');
    expect(declared?.summary).toBe(
      'Which Ferretry sections your prompt launched with (hypermedia, Pack mode, agenda mode, lessons) and how to turn each on. Check before saying one is missing.',
    );
    expect(declared).toMatchObject({ minimum: 'authenticated', caller: 'any' });
    expect(declared?.input?.safeParse({}).success).toBe(true);
    expect(declared?.input?.safeParse({ ferret: 'other' }).success).toBe(false);
  });

  test('T-0036 returns today’s text for the ferret the credential names', async () => {
    const text = (
      await instructionsAnswer(
        wren,
        async () => ({
          FY_SESSION_MODE: 'auto',
          FY_HYPERMEDIA: '1',
          FY_PACK: '0',
          FY_AGENDA: '0',
          FY_LEARNING_PASSIVE: '1',
        }),
        'fy',
      )
    ).text;
    expect(text).toBe(
      [
        'Sections ferret wren launched with (auto):',
        '  ✓ Hypermedia: on',
        '  ✗ Pack mode: off. The owner turns it on in Ferretry: open this ferret › Actions › Pack mode. It takes effect when this ferret next restarts (Actions › Restart). Settings › Pack mode, the machine’s switch, must be on too.',
        '  ✗ Agenda mode: off. The owner turns it on in Ferretry: open this ferret › Actions › Agenda mode. It takes effect when this ferret next restarts (Actions › Restart).',
        '  ✓ Lessons: on',
        'These are fixed for this run: a switch changed now is in the system prompt from the next launch.',
      ].join('\n'),
    );
  });

  test('T-0036 a ferret whose launch recorded no switches, and a caller that is no ferret, get today’s own sentences', async () => {
    expect((await instructionsAnswer(wren, async () => ({}), 'fy')).text).toBe(
      "This process was not handed ferret wren's section switches (a Codex tools server is not). Run `fy instructions` in your own shell instead.",
    );
    expect((await instructionsAnswer(undefined, async () => ({}), 'fy')).text).toStartWith(
      'This is not running inside a ferret',
    );
  });
});

/** The persisted launch environment: what the state would hold, shared by every service built over it. */
function persisted() {
  const held = new Map<string, Readonly<Record<string, string>>>();
  const record: LaunchEnvironmentRecord & { readonly writes: string[] } = {
    writes: [],
    read: async ferret => held.get(ferret) ?? {},
    write: async (ferret, environment) => {
      record.writes.push(ferret);
      held.set(ferret, environment);
    },
  };
  return { held, record };
}

function launching(
  state: ReturnType<typeof persisted>,
  parts: Record<string, string>,
  mode?: 'auto' | 'interactive',
  options: { readonly fresh?: boolean } = {},
) {
  const id = ferretId('wren');
  const stopped: FerretRecord = {
    format: 1,
    id,
    name: 'wren',
    role: 'lead',
    ...(mode === undefined ? {} : { mode }),
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work',
    state: 'stopped',
    createdAt: T0,
    stateAt: T0,
  };
  /** Every environment the launch resolved for the pane, in order. */
  const handed: Readonly<Record<string, string>>[] = [];
  const registry = new FerretRegistry(options.fresh === true ? [] : [stopped]);
  const harness = new FakeHarness();
  const store = new LaunchEnvironmentStore(state.record, async ferret => switchesOfRecord(registry.get(ferret)));
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => id,
    newName: () => 'wren',
    save: async () => {},
    saveTokens: async () => {},
    harness: () => harness,
    harnessKeys: () => ['claude-code'],
    runner: () => new FakeRunner(),
    decide: async () => ({ allow: true }),
    launchParts: () => [{ parts: async () => [{ kind: 'env', env: parts } as never] }],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: {
      childEnvironment: async (_ferret, env) => {
        handed.push(env);
        return ok(emptyChildEnvironment());
      },
    },
    asks: { open: async () => [] },
    launchEnvironment: store,
    saveDetails: async () => {
      throw new Error('the switches are not copied into details.json');
    },
  };
  const service = new FerretsService(registry, new FerretTokenDirectory(), ports);
  return { id, registry, store, ports, service, harness, handed };
}

describe('the launch environment instructions reads is PERSISTED, through one reader (RULING #30)', () => {
  const TOLD = { FY_PACK: '1', FY_HYPERMEDIA: '0', FY_AGENDA: '1' };

  test('T-0036 restart: a fresh service over the same state answers exactly what the first did', async () => {
    const state = persisted();
    const first = launching(state, TOLD, 'auto');
    expect((await first.service.resume(first.id, undefined, { origin: PERSON_ORIGIN })).ok).toBe(true);
    const before = (await instructionsAnswer(first.id, id => first.store.read(id), 'fy')).text;
    expect(before).toContain('✓ Pack mode: on');
    expect(before).toContain('✗ Hypermedia: off');

    // The daemon restarts: nothing but the state survives. A new service, a new reader, no launch in this run.
    const second = launching(state, {}, 'auto');
    const after = (await instructionsAnswer(second.id, id => second.store.read(id), 'fy')).text;
    expect(after).toBe(before);
  });

  test('T-0036 a launch records the switches only: never the token or the ferret id, and never details.json', async () => {
    const state = persisted();
    const f = launching(state, { ...TOLD, SOME_SECRET_LOOKING_NAME: 'x' }, 'interactive');
    await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
    expect(state.held.get(f.id)).toEqual({ ...TOLD, FY_SESSION_MODE: 'interactive' });
    expect(JSON.stringify([...state.held.values()])).not.toContain('FY_SESSION_TOKEN');
    expect(state.record.writes).toEqual([f.id]);
  });

  test('T-0036 today’s precedence: stored wins, derived fills in, an unresolvable derive adds nothing', async () => {
    const stored = { read: async () => ({ FY_PACK: '1' }), write: async () => {} };
    const derives = new LaunchEnvironmentStore(stored, async () => ({ FY_PACK: '0', FY_SESSION_MODE: 'auto' }));
    expect(await derives.read(wren)).toEqual({ FY_PACK: '1', FY_SESSION_MODE: 'auto' });
    const broken = new LaunchEnvironmentStore(stored, async () => {
      throw new Error('cannot resolve');
    });
    expect(await broken.read(wren)).toEqual({ FY_PACK: '1' });
    expect(switchesOfRecord(undefined)).toEqual({});
    expect(recordedSwitches({ FY_PACK: '1', FY_SESSION_TOKEN: 'never', FY_SESSION_ID: 'wren' })).toEqual({
      FY_PACK: '1',
    });
  });

  test('T-0036 a record with a mode and no stored switches still reports the mode, and no section is guessed', async () => {
    const state = persisted();
    const f = launching(state, {}, 'interactive');
    expect(await f.store.read(f.id)).toEqual({ FY_SESSION_MODE: 'interactive' });
    expect((await instructionsAnswer(f.id, id => f.store.read(id), 'fy')).text).toContain('was not handed');
  });

  test('c58-18 the mode default is part of what a launch records: Hypermedia on for an interactive ferret, off otherwise', async () => {
    expect(modeSwitchDefaults('interactive')).toEqual({ FY_HYPERMEDIA: '1' });
    expect(modeSwitchDefaults('auto')).toEqual({ FY_HYPERMEDIA: '0' });
    expect(modeSwitchDefaults(undefined)).toEqual({ FY_HYPERMEDIA: '0' });

    // No owner switch says anything (Conversation's part is silent): the launch itself records the mode's default.
    const state = persisted();
    const interactive = launching(state, {}, 'interactive');
    await interactive.service.resume(interactive.id, undefined, { origin: PERSON_ORIGIN });
    expect(state.held.get(interactive.id)).toEqual({ FY_HYPERMEDIA: '1', FY_SESSION_MODE: 'interactive' });
    const answer = (await instructionsAnswer(interactive.id, id => interactive.store.read(id), 'fy')).text;
    expect(answer).toContain('✓ Hypermedia: on');

    const autoState = persisted();
    const auto = launching(autoState, {}, 'auto');
    await auto.service.resume(auto.id, undefined, { origin: PERSON_ORIGIN });
    expect(autoState.held.get(auto.id)).toEqual({ FY_HYPERMEDIA: '0', FY_SESSION_MODE: 'auto' });
  });

  test('c58-18 an owner’s Hypermedia switch (a launch part) wins over the mode default', async () => {
    const state = persisted();
    const f = launching(state, { FY_HYPERMEDIA: '0' }, 'interactive');
    await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
    expect(state.held.get(f.id)).toEqual({ FY_HYPERMEDIA: '0', FY_SESSION_MODE: 'interactive' });
  });

  test('T-0036 a launch that is refused records nothing, and a store that fails never fails the launch', async () => {
    const refused = persisted();
    const a = launching(refused, TOLD);
    a.ports.vault.childEnvironment = async () => err({ unknown: ['GONE'] } as never);
    expect((await a.service.resume(a.id, undefined, { origin: PERSON_ORIGIN }).catch(() => undefined))?.ok).toBe(false);
    expect(refused.held.size).toBe(0);

    const failing = persisted();
    const b = launching(failing, TOLD);
    b.ports.launchEnvironment = {
      write: async () => {
        throw new Error('disk full');
      },
    };
    expect((await b.service.resume(b.id, undefined, { origin: PERSON_ORIGIN })).ok).toBe(true);
  });
});

describe('the ferret’s mode reaches the harness and the pane on every launch (v4 interactive question-tool parity)', () => {
  const MODES = [
    ['interactive', 'interactive'],
    ['auto', 'auto'],
  ] as const;

  for (const [label, mode] of MODES) {
    test(`a RESUME of an ${label} ferret hands the harness spec.mode and the pane FY_SESSION_MODE=${mode}`, async () => {
      const f = launching(persisted(), {}, mode);
      expect((await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN })).ok).toBe(true);
      expect(f.harness.launched.map(spec => spec.mode)).toEqual([mode]);
      expect(f.harness.prepared.map(spec => spec.mode)).toEqual([mode]);
      expect(f.handed.map(env => env.FY_SESSION_MODE)).toEqual([mode]);
    });

    test(`a fresh START of an ${label} ferret hands the harness spec.mode and the pane FY_SESSION_MODE=${mode}`, async () => {
      const f = launching(persisted(), {}, undefined, { fresh: true });
      f.ports.saveDetails = async () => {}; // a fresh start writes details.json; the switches never go in it (above)
      const started = await f.service.start(
        { by: 'owner', folder: '/work', harness: 'claude-code', options: { mode } },
        PERSON_ORIGIN,
      );
      expect(started.ok).toBe(true);
      expect(f.harness.launched.map(spec => spec.mode)).toEqual([mode]);
      expect(f.handed.map(env => env.FY_SESSION_MODE)).toEqual([mode]);
    });
  }

  test('a start with no mode is the start’s own default, auto: the harness and the pane both read it', async () => {
    const f = launching(persisted(), {}, undefined, { fresh: true });
    f.ports.saveDetails = async () => {}; // a fresh start writes details.json; the switches never go in it (above)
    expect((await f.service.start({ by: 'owner', folder: '/work', harness: 'claude-code' }, PERSON_ORIGIN)).ok).toBe(
      true,
    );
    expect(f.harness.launched.map(spec => spec.mode)).toEqual(['auto']);
    expect(f.handed.map(env => env.FY_SESSION_MODE)).toEqual(['auto']);
  });

  test('a record with NEITHER a mode nor a persisted start mode hands the harness no mode and the pane no variable (unattended, as an unset variable reads; a converted ferret whose details hold the mode is converted-mode.test.ts)', async () => {
    const f = launching(persisted(), {}, undefined);
    expect((await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN })).ok).toBe(true);
    expect(f.harness.launched[0]).not.toHaveProperty('mode');
    expect(f.handed[0]).not.toHaveProperty('FY_SESSION_MODE');
  });

  test('no launch part can make the pane say another mode than the harness decided from, and a part still sets its section switch', async () => {
    const f = launching(persisted(), { FY_PACK: '1', FY_SESSION_MODE: 'interactive' }, 'auto');
    await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
    expect(f.handed[0]).toMatchObject({ FY_SESSION_MODE: 'auto', FY_PACK: '1' });
    expect(f.harness.launched[0]?.mode).toBe('auto');
  });

  test('the recorded launch does not read as changed: the stored mode is the one the record derives, before and after a launch', async () => {
    for (const mode of ['interactive', 'auto'] as const) {
      const state = persisted();
      const f = launching(state, {}, mode);
      const derivedBefore = await f.store.read(f.id);
      expect(derivedBefore).toEqual({ FY_SESSION_MODE: mode });
      await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
      expect(state.held.get(f.id)).toMatchObject({ FY_SESSION_MODE: mode });
      // The mode reads the same before and after the launch, and across a restart (a fresh service over the same state).
      expect((await f.store.read(f.id)).FY_SESSION_MODE).toBe(derivedBefore.FY_SESSION_MODE);
      expect((await launching(state, {}, mode).store.read(f.id)).FY_SESSION_MODE).toBe(mode);
      // A ferret launched before this change recorded no mode: the derived one fills in, nothing contradicts it.
      const older = persisted();
      older.held.set(f.id, { FY_PACK: '1' });
      expect(await launching(older, {}, mode).store.read(f.id)).toEqual({ FY_PACK: '1', FY_SESSION_MODE: mode });
    }
  });

  test('sessionModeSwitch is the one spelling both sides use', () => {
    expect(sessionModeSwitch('interactive')).toEqual({ FY_SESSION_MODE: 'interactive' });
    expect(sessionModeSwitch('auto')).toEqual({ FY_SESSION_MODE: 'auto' });
    expect(sessionModeSwitch(undefined)).toEqual({});
    expect(switchesOfRecord({ mode: 'auto' } as FerretRecord)).toEqual(sessionModeSwitch('auto'));
  });
});
