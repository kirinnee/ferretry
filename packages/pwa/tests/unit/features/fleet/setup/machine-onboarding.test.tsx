import { afterEach, describe, expect, it } from 'bun:test';
import type { ConfigFileView, FleetMachineView, SpeedupStatus, SpeedupsView } from '@ferretry/protocol';
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
import type { ParakeetInstallSnapshot, ParakeetVoice } from '../../../../../src/lib/stt/parakeet-voice.ts';
import { DEFAULT_STT_SETTINGS } from '../../../../../src/lib/stt/stt-settings.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { config as learningConfig } from '../../../../support/learning.ts';
import { wardenConfig } from '../../../../support/warden.ts';
import { fileView } from '../../config-files/config-files-support.ts';
import { CREDENTIALS, PROFILES } from '../account-support.ts';
import {
  APPLY_PATH,
  bundle,
  credentials,
  credentialView,
  FRESH_MACHINE,
  machineAnswer,
  machineView,
  runtimes,
  runtimeView,
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

const voiceFile = (text: string): ConfigFileView =>
  fileView({ path: 'voice.yaml', kind: 'voice', schema: 'voice', text });

const installedVoice = (): ParakeetVoice => {
  const snapshot: ParakeetInstallSnapshot = {
    phase: 'installed',
    totalBytes: 683_000_000,
    downloadedBytes: 683_000_000,
    version: 'test-version',
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    refresh: async () => undefined,
  } as unknown as ParakeetVoice;
};

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

const NO_RUNTIMES = runtimes([]);
const CLAUDE_RUNTIME = runtimes([runtimeView('claude-default')]);
const CODEX_RUNTIME = runtimes([runtimeView('codex-default', { harness: 'codex' })]);

const CREDENTIAL_READS: Routes = {
  'GET /v1/fleet/credentials': CREDENTIALS,
  'GET /v1/fleet/runtimes': NO_RUNTIMES,
  'GET /v1/fleet/profiles': PROFILES,
  '/v1/fleet/setup/scan': scan(),
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
  it('lists all ten steps twice, down a column and across a phone strip, with Pair already set', async () => {
    const screen = await render();
    const column = screen.all('[data-onboarding-rail="column"] [data-onboarding-go]');
    const strip = screen.all('[data-onboarding-rail="row"] [data-onboarding-go]');
    expect(column.map(step => step.getAttribute('data-onboarding-go'))).toEqual([
      'pair',
      'start',
      'claude',
      'codex',
      'speedups',
      'voice',
      'warden',
      'learning',
      'controls',
      'done',
    ]);
    expect(strip).toHaveLength(10);
    expect(screen.all('[data-onboarding-count]').map(count => count.textContent)).toEqual(['1 of 9 set', '1 of 9 set']);
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
    expect(screen.text('[data-onboarding-count]')).toBe('1 of 9 set');
    await screen.click('[data-onboarding-rail="row"] [data-onboarding-go="learning"]');
    expect(screen.at()).toBe('learning');
  });

  it('shows Continue as set (✓) and advances', async () => {
    const screen = await render();
    await screen.click('[data-onboarding-next]');
    expect(screen.at()).toBe('claude');
    const start = screen.all('[data-onboarding-rail="column"] [data-onboarding-go="start"]')[0];
    expect(start?.getAttribute('data-state')).toBe('done');
    expect(start?.textContent).toContain('✓');
    expect(screen.text('[data-onboarding-count]')).toBe('2 of 9 set');
  });

  it('shows Skip as skipped (–), says so on the column only, and advances', async () => {
    const screen = await render();
    await screen.click('[data-onboarding-skip]');
    expect(screen.at()).toBe('claude');
    const column = screen.all('[data-onboarding-rail="column"] [data-onboarding-go="start"]')[0];
    const strip = screen.all('[data-onboarding-rail="row"] [data-onboarding-go="start"]')[0];
    expect(column?.getAttribute('data-state')).toBe('skipped');
    expect(column?.textContent).toContain('–');
    expect(column?.textContent).toContain('skipped');
    expect(strip?.textContent).toContain('–');
    expect(strip?.textContent).not.toContain('skipped,');
    expect(screen.text('[data-onboarding-count]')).toBe('1 of 9 set');
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
    expect(screen.text('[data-onboarding-count]')).toBe('1 of 9 set');
    expect(store.saves).toEqual([saved]);

    await screen.click('[data-onboarding-skip]');
    await screen.click('[data-onboarding-back]');
    expect(store.saves.map(progress => progress?.at)).toEqual(['voice', 'warden', 'voice']);
    expect(store.saves.at(-1)?.states.voice).toBe('skipped');
  });

  it('opens on the step it was told to, over the kept place, and keeps that as the place', async () => {
    const store = memory();
    const saved: MachineSetupProgress = { at: 'voice', states: { pair: 'done', start: 'done' }, start: 'fresh' };
    const screen = await render({ props: { progress: { saved, save: store.save }, startAt: 'claude' } });
    expect(screen.at()).toBe('claude');
    expect(screen.text('#machine-onboarding-title')).toBe('Claude Code');
    expect(store.saves).toEqual([{ ...saved, at: 'claude' }]);
    expect(screen.text('[data-onboarding-count]')).toBe('2 of 9 set');
  });

  it('opens on the step it was told to when nothing was kept', async () => {
    const screen = await render({ props: { startAt: 'codex' } });
    expect(screen.at()).toBe('codex');
    expect(screen.text('[data-onboarding-count]')).toBe('1 of 9 set');
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

  it('names the runtimes each CLI has now, from the machine, and links a CLI with none to Runtimes', async () => {
    const screen = await render({
      routes: {
        ...SET_UP_READS,
        'GET /v1/fleet/runtimes': runtimes([runtimeView('claude-default'), runtimeView('claude-glm')]),
      },
    });
    await screen.click('[data-onboarding-next]');
    await screen.click('[data-onboarding-next]');
    await screen.click('[data-onboarding-next]');
    await finished(screen);
    const row = (id: string) => screen.q(`[data-onboarding-summary-row="${id}"]`);
    expect(row('claude')?.textContent).toContain('claude-default, claude-glm');
    expect(row('claude')?.getAttribute('data-state')).toBe('set');
    expect(screen.q('[data-onboarding-later="claude"]')).toBeNull();
    expect(row('codex')?.getAttribute('data-state')).toBe('skipped');
    expect(row('codex')?.textContent).not.toContain('codex-default');
    const later = screen.q('[data-onboarding-later="codex"]') as HTMLAnchorElement;
    expect(later.getAttribute('href')).toBe('/d/studio/settings#machines/studio-mac/runtimes');
    await interact(() => later.click());
    expect(screen.went).toEqual(['/d/studio/settings#machines/studio-mac/runtimes']);
  });

  it('says nothing of the runtimes when the machine will not list them', async () => {
    const screen = await render({ routes: { ...SET_UP_READS, 'GET /v1/fleet/runtimes': new Error('unreachable') } });
    await finished(screen);
    expect(screen.q('[data-onboarding-summary-row="claude"]')?.textContent).not.toContain('claude-default');
    expect(screen.q('[data-onboarding-summary-row="speedups"]')?.textContent).toContain('Jev ✓ · Groq not set');
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
    expect(screen.text('[data-onboarding-count]')).toBe('1 of 9 set');
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
          return {
            config: wardenConfig({ layers: { jev: true, llm: true } }),
            accounts: wardenConfig().accounts,
            warnings: [],
          };
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
    expect(screen.text('[data-onboarding-count]')).toBe('2 of 9 set');
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
    expect(screen.text('[data-onboarding-count]')).toBe('2 of 9 set');
  });

  it('passes the clean-up choice through to the Voice step, and reads the machine default for it', async () => {
    const updates: unknown[] = [];
    const screen = await render({
      routes: { ...SET_UP_READS, '/v1/config/file?path=voice.yaml': voiceFile('defaultEngine: browser\n') },
      props: { voiceCleanup: { settings: DEFAULT_STT_SETTINGS, update: patch => updates.push(patch) } },
    });
    await screen.rail('voice');
    expect((screen.q('input[type="radio"][value="browser"]') as HTMLInputElement).checked).toBe(true);
    await screen.click('[data-setup-choice="groq"] input');
    expect(updates).toEqual([{ enhancementProvider: 'groq' }]);
  });

  it('passes the voice service through to the Voice step', async () => {
    const screen = await render({
      routes: { ...SET_UP_READS, '/v1/config/file?path=voice.yaml': voiceFile('') },
      props: { voice: installedVoice() },
    });
    await screen.rail('voice');
    expect(screen.text('[data-onboarding-step-body="voice"]')).toContain('Installed on this device.');
  });

  it('shows Parakeet as unavailable when the voice service is explicitly null', async () => {
    const screen = await render({
      routes: { ...SET_UP_READS, '/v1/config/file?path=voice.yaml': voiceFile('') },
      props: { voice: null },
    });
    await screen.rail('voice');
    expect(screen.text('[data-onboarding-step-body="voice"]')).not.toContain('Installed on this device.');
  });

  it('points at Settings for the clean-up when no clean-up choice is supplied', async () => {
    const screen = await render({
      routes: { ...SET_UP_READS, '/v1/config/file?path=voice.yaml': voiceFile('') },
    });
    await screen.rail('voice');
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

// ── Claude Code and Codex ────────────────────────────────────────────────────────────────────────

describe('MachineOnboarding · Claude Code and Codex', () => {
  const freshRoutes = (catalog: Route = NO_RUNTIMES): Routes => ({
    ...SET_UP_READS,
    '/v1/fleet/machine': FRESH_MACHINE,
    'GET /v1/fleet/runtimes': catalog,
  });
  const fresh = (catalog: Route = NO_RUNTIMES, props: Partial<MachineOnboardingProps> = {}, extra: Routes = {}) =>
    render({ routes: { ...freshRoutes(catalog), ...extra }, machine: FRESH_MACHINE, props });
  const stateOf = (screen: Screen, id: string) =>
    screen.all(`[data-onboarding-rail="column"] [data-onboarding-go="${id}"]`)[0]?.getAttribute('data-state');

  it('gives each CLI its own one-screen step, with no stepper inside it', async () => {
    const screen = await fresh(NO_RUNTIMES, { pollMs: 5 });
    await screen.rail('claude');
    expect(screen.text('#machine-onboarding-title')).toBe('Claude Code');
    expect(screen.q('[data-onboarding-step-body="claude"]')).not.toBeNull();
    expect(screen.q('[data-onboarding-step-body="codex"]')).toBeNull();
    expect(screen.q('[data-machine-stepper]')).toBeNull();
    await screen.click('[data-onboarding-next]');
    expect(screen.at()).toBe('codex');
    expect(screen.text('#machine-onboarding-title')).toBe('Codex');
    expect(screen.q('[data-onboarding-step-body="codex"]')).not.toBeNull();
    expect(screen.q('[data-onboarding-step-body="claude"]')).toBeNull();
  });

  it('marks Claude Code set (✓) when the step finds a Claude Code runtime, and not Codex', async () => {
    const screen = await fresh(CLAUDE_RUNTIME);
    expect(stateOf(screen, 'claude')).toBe('todo');
    await screen.rail('claude');
    expect(stateOf(screen, 'claude')).toBe('done');
    expect(screen.all('[data-onboarding-rail="column"] [data-onboarding-go="claude"]')[0]?.textContent).toContain('✓');
    expect(stateOf(screen, 'codex')).toBe('todo');
    expect(screen.at()).toBe('claude');
    expect(screen.text('[data-onboarding-count]')).toBe('2 of 9 set');
  });

  it('marks Codex set when the step finds a Codex runtime, and not Claude Code', async () => {
    const screen = await fresh(CODEX_RUNTIME);
    await screen.rail('codex');
    expect(stateOf(screen, 'codex')).toBe('done');
    expect(stateOf(screen, 'claude')).toBe('todo');
    expect(screen.text('[data-onboarding-count]')).toBe('2 of 9 set');
  });

  it('marks the step set when its own import makes the runtime, in place, without moving', async () => {
    let imported = false;
    const screen = await fresh(
      () => (imported ? CLAUDE_RUNTIME : NO_RUNTIMES),
      {},
      { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: { outcome: 'executed', executor: 'setup', summary: 'Imported' } },
    );
    await screen.rail('claude');
    expect(stateOf(screen, 'claude')).toBe('todo');
    expect((screen.q('[data-harness-name="claude"]') as HTMLInputElement).value).toBe('claude-default');
    imported = true;
    await screen.click('[data-change-submit]');
    const proposed = screen.calls.find(call => call.path === '/v1/fleet/proposals');
    expect(proposed?.body).toMatchObject({ change: { kind: 'setup.import', include: ['claude'] } });
    expect(stateOf(screen, 'claude')).toBe('done');
    expect(screen.at()).toBe('claude');
    expect(screen.q('[data-harness-imported="claude"]')).not.toBeNull();
  });

  it('keeps a Continue on an imported step set, and moves on', async () => {
    const screen = await fresh(CLAUDE_RUNTIME);
    await screen.rail('claude');
    await screen.click('[data-onboarding-next]');
    expect(screen.at()).toBe('codex');
    expect(stateOf(screen, 'claude')).toBe('done');
  });

  it('counts Continue on a CLI step that was not imported as skipped, not set', async () => {
    const screen = await fresh();
    await screen.rail('claude');
    await screen.click('[data-onboarding-next]');
    expect(screen.at()).toBe('codex');
    expect(stateOf(screen, 'claude')).toBe('skipped');
    await screen.click('[data-onboarding-next]');
    expect(screen.at()).toBe('speedups');
    expect(stateOf(screen, 'codex')).toBe('skipped');
    expect(screen.text('[data-onboarding-count]')).toBe('1 of 9 set');
  });

  it('counts Skip on a CLI step as skipped, and never unsets one that was imported', async () => {
    const screen = await fresh();
    await screen.rail('claude');
    await screen.click('[data-onboarding-skip]');
    expect(stateOf(screen, 'claude')).toBe('skipped');
    const imported = await fresh(CODEX_RUNTIME);
    await imported.rail('codex');
    await imported.click('[data-onboarding-skip]');
    expect(stateOf(imported, 'codex')).toBe('done');
  });

  it('keeps the runtime name typed on a step when the person leaves it and comes back', async () => {
    const store = memory();
    const screen = await fresh(NO_RUNTIMES, { progress: { saved: null, save: store.save } });
    await screen.rail('claude');
    const field = must(screen.q('[data-harness-name="claude"]') as HTMLInputElement | null, 'name field');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, ' my-claude ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(store.saves.at(-1)?.answers).toEqual({ claude: { name: 'my-claude' } });
    await screen.rail('speedups');
    expect(screen.q('[data-harness-name="claude"]')).toBeNull();
    await screen.rail('claude');
    expect((screen.q('[data-harness-name="claude"]') as HTMLInputElement).value).toBe('my-claude');
    // the other CLI's step keeps its own answers
    await screen.rail('codex');
    expect((screen.q('[data-harness-name="codex"]') as HTMLInputElement).value).toBe('codex-default');
  });

  it('reopens a step on the name kept with the saved place', async () => {
    const saved: MachineSetupProgress = {
      at: 'codex',
      states: { pair: 'done' },
      start: 'fresh',
      answers: { codex: { name: 'codex-mine' } },
    };
    const screen = await fresh(NO_RUNTIMES, { progress: { saved, save: memory().save } });
    expect(screen.at()).toBe('codex');
    expect((screen.q('[data-harness-name="codex"]') as HTMLInputElement).value).toBe('codex-mine');
  });

  it('shows no CLI step body while the machine is asleep, and still lets the person skip it', async () => {
    const screen = await render({ props: { online: false }, machine: null });
    await screen.rail('claude');
    expect(screen.text('[data-setup-note="harness-paused"]')).toContain('studio-mac is asleep or offline');
    await screen.click('[data-onboarding-skip]');
    expect(screen.at()).toBe('codex');
  });

  it('sends nothing for a skipped CLI step', async () => {
    const screen = await fresh();
    await screen.rail('claude');
    await screen.click('[data-onboarding-skip]');
    await screen.click('[data-onboarding-skip]');
    expect(screen.calls.filter(call => call.method === 'POST')).toEqual([]);
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
    expect(screen.at()).toBe('claude');
    expect(
      screen.all('[data-onboarding-rail="column"] [data-onboarding-go="start"]')[0]?.getAttribute('data-state'),
    ).toBe('done');
    await finished(screen);
    expect(screen.q('[data-onboarding-summary-row="start"]')?.textContent).toContain('cloned from work-linux');
  });

  it('draws no step list, no “Step n of m” and no stepper title of its own inside the Start step', async () => {
    const screen = await render({ machine: FRESH_MACHINE });
    await screen.click('[data-setup-choice="clone"] input');
    const body = must(screen.q('[data-onboarding-step-body="start"]'), 'start body');
    expect(body.querySelector('[data-presentation="embedded"]')).not.toBeNull();
    expect(body.textContent).not.toMatch(/Step \d+ of \d+/);
    expect(body.querySelector('#machine-stepper-title')).toBeNull();
    expect(body.querySelector('[data-stepper-back]')).toBeNull();
  });

  it('drops the clone when a fresh start is chosen again', async () => {
    const screen = await render({ machine: FRESH_MACHINE });
    await screen.click('[data-setup-choice="clone"] input');
    expect(screen.q('[data-onboarding-step-body="start"] [data-machine-stepper]')).not.toBeNull();
    await screen.click('[data-setup-choice="fresh"] input');
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
