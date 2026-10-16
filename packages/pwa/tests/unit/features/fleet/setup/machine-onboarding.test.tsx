import { afterEach, describe, expect, it } from 'bun:test';
import type { FleetMachineView, SpeedupStatus, SpeedupsView } from '@ferretry/protocol';
import type { z } from 'zod';
import type { FleetClient, FleetClientFactory } from '../../../../../src/features/fleet/fleet-client.ts';
import {
  MachineOnboarding,
  type MachineOnboardingProps,
} from '../../../../../src/features/fleet/setup/machine-onboarding.tsx';
import {
  type MachineSetupProgress,
  ONBOARDING_START,
} from '../../../../../src/features/fleet/setup/onboarding-model.ts';
import type { PairingClientFactory } from '../../../../../src/features/settings/add-device-settings.tsx';
import type { DaemonConnectionRecord } from '../../../../../src/lib/connections.ts';
import type { DaemonConnection } from '../../../../../src/lib/daemon-connection.ts';
import { DEFAULT_STT_SETTINGS } from '../../../../../src/lib/stt/stt-settings.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { config as learningConfig } from '../../../../support/learning.ts';
import { wardenConfig } from '../../../../support/warden.ts';
import { CREDENTIALS, PROFILES, RUNTIMES } from '../account-support.ts';
import {
  APPLY_PATH,
  bundle,
  credentials,
  credentialView,
  FRESH_MACHINE,
  machineAnswer,
  machineView,
  STAGED,
  STUDIO,
  scan,
  WORK,
} from './setup-support.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const WORK_RECORD: DaemonConnectionRecord = { ...WORK, label: 'work-linux', pairedAt: 0, lastSelectedAt: 0 };

const speedupStatus = (overrides: Partial<SpeedupStatus>): SpeedupStatus => ({
  provider: 'groq',
  label: 'Groq',
  purpose: 'Cleans up dictated text.',
  costNote: 'Well under a cent.',
  privacyNote: 'Text goes to Groq.',
  keyUrl: 'https://console.groq.com/keys',
  testNote: 'Test lists models. Free.',
  secretName: 'GROQ_API_KEY',
  set: false,
  testStale: false,
  ...overrides,
});

const speedups = (jevSet: boolean): SpeedupsView => ({
  vault: 'ok',
  providers: [
    speedupStatus({ provider: 'jev', label: 'Jev', secretName: 'JEV_API_KEY', set: jevSet }),
    speedupStatus({}),
  ],
});

const wardenView = () => ({ config: wardenConfig(), accounts: wardenConfig().accounts, warnings: [] });

type Call = { readonly path: string; readonly method: string; readonly body: unknown };
type Route = unknown | Error | ((call: Call) => unknown);
type Routes = Readonly<Record<string, Route>>;

/** A scripted daemon: `"METHOD /path"` first, then `"/path"`; a route with no answer fails like an unreachable machine. */
const daemon = (routes: Routes, calls: Call[] = []): FleetClient => ({
  request: async <T,>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const method = init?.method ?? 'GET';
    const call: Call = { path, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const key = `${method} ${path}` in routes ? `${method} ${path}` : path;
    if (!(key in routes)) throw new Error(`no route ${method} ${path}`);
    const answer = routes[key];
    const value = typeof answer === 'function' ? (answer as (call: Call) => unknown)(call) : answer;
    if (value instanceof Error) throw value;
    return schema.parse(value);
  },
});

const CREDENTIAL_READS: Routes = {
  'GET /v1/fleet/credentials': CREDENTIALS,
  'GET /v1/fleet/runtimes': RUNTIMES,
  'GET /v1/fleet/profiles': PROFILES,
};

const SET_UP_READS: Routes = {
  ...CREDENTIAL_READS,
  '/v1/speedups': speedups(true),
  '/v1/warden/config': wardenView(),
  '/v1/learning/config': learningConfig(),
};

const memory = () => {
  const saves: (MachineSetupProgress | null)[] = [];
  return { saves, save: (next: MachineSetupProgress | null) => saves.push(next) };
};

// ── Driving ──────────────────────────────────────────────────────────────────────────────────────

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
  });
};

const open: Mounted[] = [];

afterEach(async () => {
  for (const view of open.splice(0)) await view.unmount();
});

interface Options {
  readonly routes?: Routes;
  readonly work?: Routes;
  readonly machine?: FleetMachineView | null;
  readonly createClient?: FleetClientFactory;
  readonly props?: Partial<MachineOnboardingProps>;
}

const render = async ({
  routes = SET_UP_READS,
  work = {},
  machine = machineView(),
  createClient,
  props,
}: Options = {}) => {
  const calls: Call[] = [];
  const left = { finish: 0, later: 0, retried: 0 };
  const went: string[] = [];
  const target = daemon(routes, calls);
  const source = daemon({
    '/v1/fleet/machine': machineView({ name: 'work-linux', runtimeCount: 3 }),
    '/v1/fleet/export': bundle(),
    ...work,
  });
  const factory: FleetClientFactory =
    createClient ?? (async (connection: DaemonConnection) => (connection.daemonId === WORK.daemonId ? source : target));
  const view = await mount(
    <MachineOnboarding
      connection={STUDIO}
      machineName="studio-mac"
      machine={machine}
      online
      checking={false}
      onRetry={() => {
        left.retried += 1;
      }}
      createClient={factory}
      sources={[WORK_RECORD]}
      onFinish={() => {
        left.finish += 1;
      }}
      onLeave={() => {
        left.later += 1;
      }}
      onNavigate={to => went.push(to)}
      {...props}
    />,
  );
  open.push(view);
  await settle();
  const q = (selector: string) => view.container.querySelector(selector);
  const all = (selector: string) => [...view.container.querySelectorAll<HTMLElement>(selector)];
  const click = async (selector: string, index = 0): Promise<void> => {
    const element = must(all(selector)[index] ?? null, selector);
    await interact(() => element.click());
    await settle();
  };
  const at = () => q('[data-machine-onboarding]')?.getAttribute('data-onboarding-at');
  const rail = (id: string) => click(`[data-onboarding-rail="column"] [data-onboarding-go="${id}"]`);
  const text = (selector: string) => q(selector)?.textContent ?? '';
  return { view, calls, left, went, q, all, click, at, rail, text };
};

type Screen = Awaited<ReturnType<typeof render>>;

const finished = (screen: Screen): Promise<void> => screen.rail('done');

// ── The rail ─────────────────────────────────────────────────────────────────────────────────────

describe('MachineOnboarding · the rail', () => {
  it('lists all nine steps twice, down a column and across a phone strip, with Pair already set', async () => {
    const screen = await render();
    const column = screen.all('[data-onboarding-rail="column"] [data-onboarding-go]');
    const strip = screen.all('[data-onboarding-rail="row"] [data-onboarding-go]');
    expect(column.map(step => step.getAttribute('data-onboarding-go'))).toEqual([
      'pair',
      'start',
      'logins',
      'speedups',
      'voice',
      'warden',
      'learning',
      'controls',
      'done',
    ]);
    expect(strip).toHaveLength(9);
    expect(screen.all('[data-onboarding-count]').map(count => count.textContent)).toEqual(['1 of 8 set', '1 of 8 set']);
    expect(column[0]?.getAttribute('data-state')).toBe('done');
    expect(column[0]?.textContent).toContain('✓');
    expect(column[0]?.textContent).toContain(', set');
    expect(column[1]?.getAttribute('data-state')).toBe('todo');
    expect(column[1]?.getAttribute('aria-current')).toBe('step');
    expect(screen.at()).toBe('start');
  });

  it('opens any step with one tap, and says which one is open', async () => {
    const screen = await render();
    await screen.rail('warden');
    expect(screen.at()).toBe('warden');
    expect(screen.text('#machine-onboarding-title')).toBe('Warden');
    const current = screen.all('[aria-current="step"]');
    expect(current.map(step => step.getAttribute('data-onboarding-go'))).toEqual(['warden', 'warden']);
    // Looking is not doing: opening a step sets nothing.
    expect(screen.text('[data-onboarding-count]')).toBe('1 of 8 set');
    await screen.click('[data-onboarding-rail="row"] [data-onboarding-go="learning"]');
    expect(screen.at()).toBe('learning');
  });

  it('shows Continue as set (✓) and advances', async () => {
    const screen = await render();
    await screen.click('[data-onboarding-next]');
    expect(screen.at()).toBe('logins');
    const start = screen.all('[data-onboarding-rail="column"] [data-onboarding-go="start"]')[0];
    expect(start?.getAttribute('data-state')).toBe('done');
    expect(start?.textContent).toContain('✓');
    expect(screen.text('[data-onboarding-count]')).toBe('2 of 8 set');
  });

  it('shows Skip as skipped (–), says so on the column only, and advances', async () => {
    const screen = await render();
    await screen.click('[data-onboarding-skip]');
    expect(screen.at()).toBe('logins');
    const column = screen.all('[data-onboarding-rail="column"] [data-onboarding-go="start"]')[0];
    const strip = screen.all('[data-onboarding-rail="row"] [data-onboarding-go="start"]')[0];
    expect(column?.getAttribute('data-state')).toBe('skipped');
    expect(column?.textContent).toContain('–');
    expect(column?.textContent).toContain('skipped');
    expect(strip?.textContent).toContain('–');
    expect(strip?.textContent).not.toContain('skipped,');
    expect(screen.text('[data-onboarding-count]')).toBe('1 of 8 set');
  });

  it('never unsets a step that was set when it is skipped on a second visit', async () => {
    const screen = await render();
    await screen.click('[data-onboarding-next]');
    await screen.rail('start');
    await screen.click('[data-onboarding-skip]');
    const start = screen.all('[data-onboarding-rail="column"] [data-onboarding-go="start"]')[0];
    expect(start?.getAttribute('data-state')).toBe('done');
  });

  it('goes Back a step, and has no Back on Pair', async () => {
    const screen = await render();
    expect(screen.q('[data-onboarding-back]')).not.toBeNull();
    await screen.click('[data-onboarding-back]');
    expect(screen.at()).toBe('pair');
    expect(screen.q('[data-onboarding-back]')).toBeNull();
    expect(screen.q('[data-onboarding-step-body="pair"]')).not.toBeNull();
  });

  it('Finish later leaves, and is not offered on Done', async () => {
    const screen = await render();
    await screen.click('[data-onboarding-later-all]');
    expect(screen.left.later).toBe(1);
    await finished(screen);
    expect(screen.q('[data-onboarding-later-all]')).toBeNull();
  });
});

// ── Progress ─────────────────────────────────────────────────────────────────────────────────────

describe('MachineOnboarding · the kept place', () => {
  it('starts from what was saved, and saves on every move', async () => {
    const store = memory();
    const saved: MachineSetupProgress = { at: 'voice', states: { pair: 'done', start: 'skipped' }, start: 'fresh' };
    const screen = await render({ props: { progress: { saved, save: store.save } } });
    expect(screen.at()).toBe('voice');
    expect(screen.text('[data-onboarding-count]')).toBe('1 of 8 set');
    expect(store.saves).toEqual([saved]);

    await screen.click('[data-onboarding-skip]');
    await screen.click('[data-onboarding-back]');
    expect(store.saves.map(progress => progress?.at)).toEqual(['voice', 'warden', 'voice']);
    expect(store.saves.at(-1)?.states.voice).toBe('skipped');
  });

  it('starts at the beginning when nothing was saved, and works with no storage at all', async () => {
    const store = memory();
    const kept = await render({ props: { progress: { saved: null, save: store.save } } });
    expect(kept.at()).toBe(ONBOARDING_START.at);
    expect(store.saves).toEqual([ONBOARDING_START]);
    const bare = await render();
    expect(bare.at()).toBe('start');
  });
});

// ── Done ─────────────────────────────────────────────────────────────────────────────────────────

describe('MachineOnboarding · Done', () => {
  it('says what was set from what the machine holds, and links skipped steps to Settings', async () => {
    const screen = await render();
    await screen.click('[data-onboarding-next]');
    await finished(screen);
    expect(screen.text('#machine-onboarding-title')).toBe('studio-mac is set up');
    const row = (id: string) => screen.q(`[data-onboarding-summary-row="${id}"]`);
    expect(row('start')?.textContent).toContain('fresh setup');
    expect(row('speedups')?.textContent).toContain('Jev ✓ · Groq not set');
    expect(row('warden')?.textContent).toContain('No AI runs and nothing is spent.');
    expect(row('learning')?.textContent).toContain('passive on for new ferrets');
    // Only the keys' state is shown: never a value.
    expect(screen.text('[data-onboarding-summary]')).not.toContain('JEV_API_KEY');
    expect(row('voice')?.getAttribute('data-state')).toBe('not visited');
    const later = screen.q('[data-onboarding-later="voice"]') as HTMLAnchorElement;
    await interact(() => later.click());
    expect(screen.went).toEqual([later.getAttribute('href') ?? '']);
    expect(screen.q('[data-onboarding-later="start"]')).toBeNull();
  });

  it('says only what it could read when some of the reads fail', async () => {
    const screen = await render({ routes: { ...CREDENTIAL_READS, '/v1/speedups': speedups(false) } });
    await finished(screen);
    expect(screen.q('[data-onboarding-summary-row="speedups"]')?.textContent).toContain('Jev not set · Groq not set');
    expect(screen.q('[data-onboarding-summary-row="warden"]')?.textContent).not.toContain('sweep');
    expect(screen.q('[data-onboarding-summary-row="learning"]')?.textContent).not.toContain('passive');
  });

  it('says nothing about the machine when no client can be made, and still finishes', async () => {
    const screen = await render({
      createClient: async () => {
        throw new Error('unreachable');
      },
    });
    await finished(screen);
    expect(screen.q('[data-onboarding-summary-row="speedups"]')?.textContent).not.toContain('✓');
    expect(screen.q('[data-onboarding-summary-row="speedups"]')?.textContent).not.toContain('not set');
    await screen.click('[data-onboarding-finish]');
    expect(screen.left.finish).toBe(1);
  });

  it('Finish setup forgets the kept place, then finishes', async () => {
    const store = memory();
    const screen = await render({ props: { progress: { saved: null, save: store.save } } });
    await finished(screen);
    await screen.click('[data-onboarding-finish]');
    expect(store.saves.at(-1)).toBeNull();
    expect(screen.left.finish).toBe(1);
  });

  it('Start again goes back to the start with only Pair set', async () => {
    const screen = await render();
    await screen.click('[data-onboarding-next]');
    await finished(screen);
    await screen.click('[data-onboarding-restart]');
    expect(screen.at()).toBe('start');
    expect(screen.text('[data-onboarding-count]')).toBe('1 of 8 set');
  });

  it('does not read the machine until Done opens', async () => {
    const screen = await render();
    expect(screen.calls.some(call => call.path === '/v1/speedups')).toBe(false);
    await finished(screen);
    expect(screen.calls.some(call => call.path === '/v1/speedups')).toBe(true);
  });
});

// ── Steps that save on their own ─────────────────────────────────────────────────────────────────

describe('MachineOnboarding · steps that save through their own surface', () => {
  it('marks Warden set when its Save lands, without moving', async () => {
    const patched: Call[] = [];
    const screen = await render({
      routes: {
        ...SET_UP_READS,
        'PATCH /v1/warden/config': (call: Call) => {
          patched.push(call);
          return { config: wardenConfig({ triage: 'jev' }), accounts: wardenConfig().accounts, warnings: [] };
        },
      },
    });
    await screen.rail('warden');
    expect(screen.text('[data-onboarding-step-body="warden"]')).toContain('A Jev key is set');
    const save = must(
      screen.all('[data-onboarding-step-body="warden"] button').find(button => button.textContent === 'Save') ?? null,
      'Save',
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await interact(() => save.click());
    await settle();
    expect(patched).toHaveLength(1);
    expect(screen.at()).toBe('warden');
    expect(screen.text('[data-onboarding-count]')).toBe('2 of 8 set');
    expect(
      screen.all('[data-onboarding-rail="column"] [data-onboarding-go="warden"]')[0]?.getAttribute('data-state'),
    ).toBe('done');
  });

  it('marks Learning set when a choice lands, without moving', async () => {
    const patched: Call[] = [];
    const screen = await render({
      routes: {
        ...SET_UP_READS,
        'PATCH /v1/learning/config': (call: Call) => {
          patched.push(call);
          return learningConfig({ passiveDefault: false });
        },
      },
    });
    await screen.rail('learning');
    await screen.click('[data-setup-choice="off"] input');
    expect(patched.map(call => call.body)).toEqual([{ passiveDefault: false }]);
    expect(screen.at()).toBe('learning');
    expect(screen.text('[data-onboarding-count]')).toBe('2 of 8 set');
  });

  it('passes the voice engine and the clean-up choice through to the Voice step', async () => {
    const updates: unknown[] = [];
    const screen = await render({
      props: {
        voiceEngine: <p data-test-engine="">Parakeet, from the engine</p>,
        voiceCleanup: { settings: DEFAULT_STT_SETTINGS, update: patch => updates.push(patch) },
      },
    });
    await screen.rail('voice');
    expect(screen.q('[data-test-engine]')).not.toBeNull();
    expect(screen.q('[data-onboarding-voice-engine]')).toBeNull();
    await screen.click('[data-setup-choice="groq"] input');
    expect(updates).toEqual([{ enhancementProvider: 'groq' }]);
  });

  it('names the browser engine and points at Settings when the voice seams are not supplied', async () => {
    const screen = await render();
    await screen.rail('voice');
    expect(screen.q('[data-onboarding-voice-engine="browser"]')).not.toBeNull();
    expect(screen.q('[data-onboarding-voice-cleanup="settings"]')).not.toBeNull();
  });

  it('hands the pairing client through to the Pair step', async () => {
    const createPairingClient = (async () => {
      throw new Error('not used until a code is asked for');
    }) as unknown as PairingClientFactory;
    const screen = await render({ props: { createPairingClient } });
    await screen.rail('pair');
    expect(screen.q('[data-onboarding-pair-phone]')).not.toBeNull();
  });
});

// ── Logins ───────────────────────────────────────────────────────────────────────────────────────

describe('MachineOnboarding · Logins', () => {
  const freshRoutes: Routes = {
    ...SET_UP_READS,
    '/v1/fleet/machine': FRESH_MACHINE,
    '/v1/fleet/setup/scan': scan({ tools: scan().tools }),
  };
  const fresh = (props: Partial<MachineOnboardingProps> = {}) =>
    render({ routes: freshRoutes, machine: FRESH_MACHINE, props });

  it('continues when the Claude Code and Codex check is done', async () => {
    const screen = await fresh();
    await screen.rail('logins');
    expect(screen.q('[data-onboarding-step-body="logins"]')).not.toBeNull();
    await screen.click('[data-step-next]');
    await screen.click('[data-harness-skip]');
    await screen.click('[data-harness-skip]');
    expect(screen.at()).toBe('logins');
    await screen.click('[data-first-run-finish]');
    expect(screen.at()).toBe('speedups');
    expect(
      screen.all('[data-onboarding-rail="column"] [data-onboarding-go="logins"]')[0]?.getAttribute('data-state'),
    ).toBe('done');
  });

  it('skips Logins when the check is left', async () => {
    const kept: unknown[] = [];
    const screen = await fresh({ firstRunProgress: { saved: null, save: next => kept.push(next) } });
    await screen.rail('logins');
    await screen.click('[data-stepper-back]');
    const stop = screen.q('[data-stepper-stop]');
    if (stop !== null) await screen.click('[data-stepper-stop]');
    expect(screen.at()).toBe('speedups');
    expect(
      screen.all('[data-onboarding-rail="column"] [data-onboarding-go="logins"]')[0]?.getAttribute('data-state'),
    ).toBe('skipped');
  });

  it('shows only the logins list, not the first-run check, on a machine that is set up', async () => {
    const screen = await render();
    await screen.rail('logins');
    expect(screen.q('[data-setup-section="logins-import"]')).toBeNull();
    expect(screen.q('[data-setup-section="logins-list"]')).not.toBeNull();
  });
});

// ── Start from › Clone ───────────────────────────────────────────────────────────────────────────

describe('MachineOnboarding · Start from › Clone', () => {
  const EXECUTED = { outcome: 'executed', executor: 'clone', summary: 'Copied 3 runtimes from work-linux' };
  const SLOTS = credentials([credentialView('claude-work', { clonedFrom: 'work-linux', usedBy: ['claude-default'] })]);

  it('reports the source of a finished copy, continues, and Done says where it was cloned from', async () => {
    let copied = false;
    const screen = await render({
      machine: FRESH_MACHINE,
      routes: {
        ...SET_UP_READS,
        '/v1/fleet/machine': machineAnswer(),
        'GET /v1/fleet/profiles': { format: 'version-2', profiles: [] },
        '/v1/fleet/proposals': STAGED,
        [APPLY_PATH]: () => {
          copied = true;
          return EXECUTED;
        },
        'GET /v1/fleet/credentials': () => (copied ? SLOTS : credentials([])),
      },
    });
    await screen.click('[data-setup-choice="clone"] input');
    expect(screen.q('[data-onboarding-step-body="start"] [data-machine-stepper]')).not.toBeNull();
    await screen.click('[data-setup-choice="work"] input');
    await screen.click('[data-step-next]');
    await screen.click('[data-change-submit]');
    expect(copied).toBe(true);
    expect(screen.left.retried).toBeGreaterThan(0);
    await screen.click('[data-clone-finish]');
    expect(screen.at()).toBe('logins');
    expect(
      screen.all('[data-onboarding-rail="column"] [data-onboarding-go="start"]')[0]?.getAttribute('data-state'),
    ).toBe('done');
    await finished(screen);
    expect(screen.q('[data-onboarding-summary-row="start"]')?.textContent).toContain('cloned from work-linux');
  });

  it('goes back to a fresh start when the clone is left', async () => {
    const screen = await render({ machine: FRESH_MACHINE });
    await screen.click('[data-setup-choice="clone"] input');
    expect(screen.q('[data-onboarding-step-body="start"] [data-machine-stepper]')).not.toBeNull();
    await screen.click('[data-stepper-back]');
    expect(screen.q('[data-onboarding-step-body="start"] [data-machine-stepper]')).toBeNull();
    expect(screen.at()).toBe('start');
    expect((screen.q('[data-setup-choice="fresh"] input') as HTMLInputElement).checked).toBe(true);
  });
});

// ── Moving the reader ────────────────────────────────────────────────────────────────────────────

describe('MachineOnboarding · focus and the phone strip', () => {
  it('takes focus to the title when the step changes, but not on arrival', async () => {
    const screen = await render();
    const title = must(screen.q('#machine-onboarding-title'), 'title');
    expect(document.activeElement).not.toBe(title);
    await screen.click('[data-onboarding-next]');
    expect(document.activeElement).toBe(screen.q('#machine-onboarding-title'));
  });

  it('scrolls the open step into view on the phone strip', async () => {
    const offsets = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft');
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get: () => 300 });
    try {
      const screen = await render();
      const strip = must(screen.q('[data-onboarding-rail="row"]'), 'strip') as HTMLElement;
      expect(strip.scrollLeft).toBe(252);
      Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get: () => 10 });
      await screen.click('[data-onboarding-next]');
      expect(strip.scrollLeft).toBe(0);
    } finally {
      if (offsets === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'offsetLeft');
      else Object.defineProperty(HTMLElement.prototype, 'offsetLeft', offsets);
    }
  });
});

describe('MachineOnboarding · Agent controls', () => {
  it('opens the Machine tab’s own controls once the machine has answered', async () => {
    const screen = await render({ routes: { ...SET_UP_READS, '/v1/fleet/machine': machineView() } });
    await screen.rail('controls');
    expect(screen.q('[data-onboarding-step-body="controls"]')).not.toBeNull();
  });

  it('waits for the machine instead of showing controls it cannot read', async () => {
    const screen = await render({ machine: null });
    await screen.rail('controls');
    expect(screen.text('[data-onboarding-reading="controls"]')).toBe('studio-mac’s controls show once it answers.');
  });
});
