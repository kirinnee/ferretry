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
import { PROVIDERS } from '../credentials/environment-support.ts';
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

  it('heads every page “Set up <machine>”, with a small Finish later link rather than a button in the footer', async () => {
    const screen = await render();
    expect(screen.text('[data-machine-onboarding] p.kt-label')).toBe('Set up studio-mac');
    const later = must(screen.q('[data-onboarding-later-all]'), 'Finish later');
    expect(later.textContent).toBe('Finish later');
    expect(later.closest('[data-onboarding-foot]')).toBeNull();
    expect(later.getAttribute('data-variant')).toBeNull();
  });

  it('shows no page with two primary buttons', async () => {
    const screen = await render({ props: { voice: installedVoice() } });
    const steps = ['pair', 'start', 'claude', 'codex', 'speedups', 'voice', 'warden', 'learning', 'controls', 'done'];
    const counts: Record<string, number> = {};
    for (const step of steps) {
      await screen.rail(step);
      counts[step] = screen.all('button[data-variant="primary"]').length;
    }
    for (const step of steps) expect(counts[step]).toBeLessThanOrEqual(1);
    // The pages that do their own thing put it in the footer, beside Back and Skip.
    for (const step of ['claude', 'codex', 'speedups']) {
      await screen.rail(step);
      expect(screen.q('[data-onboarding-next]')).toBeNull();
      expect(screen.all('[data-onboarding-foot] button[data-variant="primary"]').length).toBeLessThanOrEqual(1);
    }
    await screen.rail('warden');
    expect(screen.q('[data-onboarding-foot] [data-onboarding-next]')).not.toBeNull();
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
    await screen.click('[data-onboarding-primary="continue"]');
    await screen.click('[data-onboarding-skip]');
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

  describe('Voice', () => {
    let railState: string | null | undefined;
    const voiceDone = async (text: string) => {
      const screen = await render({ routes: { ...SET_UP_READS, '/v1/config/file?path=voice.yaml': voiceFile(text) } });
      await screen.rail('voice');
      await screen.click('[data-onboarding-next]');
      railState = screen
        .all('[data-onboarding-rail="column"] [data-onboarding-go="voice"]')[0]
        ?.getAttribute('data-state');
      await finished(screen);
      return must(screen.q('[data-onboarding-summary-row="voice"]'), 'the Voice row');
    };

    it('does not claim Voice set when Continue passed it with no engine picked', async () => {
      const row = await voiceDone('');
      expect(railState).toBe('skipped');
      expect(row.getAttribute('data-state')).toBe('skipped');
      expect(row.textContent).toContain('no speech engine picked');
      expect(row.querySelector('[data-onboarding-later="voice"]')).not.toBeNull();
    });

    it('says which engine the machine defaults to when one is picked', async () => {
      const parakeet = await voiceDone('defaultEngine: parakeet\n');
      expect(railState).toBe('done');
      expect(parakeet.getAttribute('data-state')).toBe('set');
      expect(parakeet.textContent).toContain('Parakeet, on each device');
    });

    it('names phone/browser voice too', async () => {
      const browser = await voiceDone('defaultEngine: browser\n');
      expect(browser.textContent).toContain('phone/browser voice');
    });
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

  it('offers one primary, Finish setup, and no Start again, Continue or Skip', async () => {
    const screen = await render();
    await finished(screen);
    const primaries = screen.all('button[data-variant="primary"]');
    expect(primaries.map(button => button.textContent)).toEqual(['Finish setup']);
    expect(screen.q('[data-onboarding-restart]')).toBeNull();
    expect(screen.q('[data-onboarding-next]')).toBeNull();
    expect(screen.q('[data-onboarding-skip]')).toBeNull();
    expect(screen.q('[data-onboarding-later-all]')).toBeNull();
    expect(screen.q('[data-onboarding-back]')).not.toBeNull();
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
  describe('Warden', () => {
    /** A Warden that keeps what was PATCHed, so Done reads back what was saved. */
    const wardenRoutes = (patch: Route = undefined) => {
      const patched: Call[] = [];
      let config = wardenConfig();
      const routes: Routes = {
        ...SET_UP_READS,
        'GET /v1/warden/config': () => ({ config, accounts: config.accounts, warnings: [] }),
        'PATCH /v1/warden/config': (call: Call) => {
          patched.push(call);
          if (patch instanceof Error) return patch;
          const body = call.body as Partial<typeof config>;
          config = { ...config, ...body, layers: { ...config.layers, ...body.layers } };
          return { config, accounts: config.accounts, warnings: [] };
        },
      };
      return { routes, patched };
    };
    const wardenState = (screen: Screen) =>
      screen.all('[data-onboarding-rail="column"] [data-onboarding-go="warden"]')[0]?.getAttribute('data-state');

    it('opens with Jev switched on, unsaved: the one primary is Save and continue, and the card has no Save', async () => {
      const { routes } = wardenRoutes();
      const screen = await render({ routes });
      await screen.rail('warden');
      expect(screen.text('[data-onboarding-step-body="warden"]')).toContain('A Jev key is set');
      expect(primaries(screen)).toEqual(['Save and continue']);
      const inBody = screen.all('[data-onboarding-step-body="warden"] button').map(button => button.textContent);
      expect(inBody).not.toContain('Save');
      expect(screen.text('[data-onboarding-warden-unsaved]')).toContain('Save and continue puts these in effect');
    });

    it('Save and continue saves what is on screen, sets the step, moves on, and Done says Jev is on', async () => {
      const { routes, patched } = wardenRoutes();
      const screen = await render({ routes });
      await screen.rail('warden');
      await screen.click('[data-onboarding-next="save"]');
      expect(patched).toHaveLength(1);
      expect(patched[0]?.body).toMatchObject({ layers: { jev: true } });
      expect(wardenState(screen)).toBe('done');
      expect(screen.at()).toBe('learning');
      await finished(screen);
      expect(screen.q('[data-onboarding-summary-row="warden"]')?.textContent).not.toContain('No AI runs');
    });

    it('stays on Warden and says why when the save is refused: nothing is claimed', async () => {
      const { routes, patched } = wardenRoutes(new Error('The Warden said no.'));
      const screen = await render({ routes });
      await screen.rail('warden');
      await screen.click('[data-onboarding-next="save"]');
      expect(patched).toHaveLength(1);
      expect(screen.at()).toBe('warden');
      expect(wardenState(screen)).toBe('todo');
      expect(screen.q('[data-onboarding-step-body="warden"] [role="alert"]')).not.toBeNull();
      expect(primaries(screen)).toEqual(['Save and continue']);
    });

    it('keeps a plain Continue, and sends nothing, when nothing on the card changed', async () => {
      const { routes, patched } = wardenRoutes();
      const screen = await render({ routes: { ...routes, '/v1/speedups': speedups(false) } });
      await screen.rail('warden');
      expect(primaries(screen)).toEqual(['Continue']);
      await screen.click('[data-onboarding-next]');
      expect(patched).toHaveLength(0);
      expect(screen.at()).toBe('learning');
    });

    it('Skip leaves the machine as it is', async () => {
      const { routes, patched } = wardenRoutes();
      const screen = await render({ routes });
      await screen.rail('warden');
      await screen.click('[data-onboarding-skip]');
      expect(patched).toHaveLength(0);
      expect(screen.at()).toBe('learning');
    });
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
    await screen.click('[data-onboarding-skip]');
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

  it('moves on by itself when its import succeeds and sets the step, with no “ready” banner on the next page', async () => {
    let imported = false;
    const screen = await fresh(
      () => (imported ? CLAUDE_RUNTIME : NO_RUNTIMES),
      {},
      { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: { outcome: 'executed', executor: 'setup', summary: 'Imported' } },
    );
    await screen.rail('claude');
    expect(stateOf(screen, 'claude')).toBe('todo');
    expect(screen.text('[data-harness-runtime-line]')).toContain('claude-default');
    expect(screen.q('[data-setup-note="import-carry"]')).toBeNull();
    imported = true;
    await screen.click('[data-onboarding-primary="import"]');
    const proposed = screen.calls.find(call => call.path === '/v1/fleet/proposals');
    expect(proposed?.body).toMatchObject({ change: { kind: 'setup.import', include: ['claude'] } });
    expect(stateOf(screen, 'claude')).toBe('done');
    expect(screen.at()).toBe('codex');
    // The rail's tick says it; a good import leaves nothing to do, so the next page carries nothing.
    expect(screen.q('[data-setup-note="import-carry"]')).toBeNull();
  });

  it('carries only what is left to do: a sign-in link for a login that still needs one, not the counts', async () => {
    let imported = false;
    const signedOut = runtimes([
      runtimeView('claude-default', { credential: { id: 'claude-work', store: 'ferretry', status: 'needs_sign_in' } }),
    ]);
    const adopt = { adopted: [{ id: 'a', session: 's-a', name: 'ferret-a', status: 'stopped' }], refused: [] };
    const recent = {
      id: 'a',
      harness: 'claude',
      project: '/work/shop',
      preview: 'conversation a',
      lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
      turns: 3,
    };
    const screen = await fresh(
      () => (imported ? signedOut : NO_RUNTIMES),
      {},
      {
        '/v1/fleet/proposals': STAGED,
        [APPLY_PATH]: { outcome: 'executed', executor: 'setup', summary: 'Imported' },
        '/v1/imports/conversations?harness=claude&limit=5000': { conversations: [recent], matched: 1, skipped: 0 },
        '/v1/imports/conversations/adopt': adopt,
      },
    );
    await screen.rail('claude');
    await screen.click('[data-harness-conversations]');
    imported = true;
    await screen.click('[data-onboarding-primary="import"]');
    const note = must(screen.q('[data-setup-note="import-carry"]'), 'the carried note');
    expect(note.getAttribute('data-tone')).toBe('warn');
    expect(note.textContent).toContain('Still to do from Claude Code');
    // The conversations went in: said once, on Done, never twice on this page.
    expect(note.textContent).not.toContain('conversation');
    const link = must(note.querySelector('[data-carry-sign-in]'), 'the sign-in link');
    expect(link.textContent).toBe('Sign in claude-default later');
    expect(link.getAttribute('data-carry-sign-in')).toBe('claude-work');
    await finished(screen);
    expect(screen.text('[data-onboarding-notes]')).toContain('Brought in 1 conversation.');
  });

  it('an import that makes no runtime moves on with nothing carried', async () => {
    const screen = await render({
      routes: {
        ...freshRoutes(NO_RUNTIMES),
        '/v1/fleet/setup/scan': scan({
          runtimes: [],
          duplicates: [{ harness: 'claude', existing: 'claude-default', suggested: 'claude-default-2' }],
        }),
        '/v1/fleet/proposals': STAGED,
        [APPLY_PATH]: { outcome: 'executed', executor: 'setup', summary: 'Imported' },
      },
      machine: FRESH_MACHINE,
    });
    await screen.rail('claude');
    await screen.click('[data-onboarding-primary="import"]');
    expect(screen.at()).toBe('codex');
    expect(screen.q('[data-setup-note="import-carry"]')).toBeNull();
  });

  it('a revisit that brings in only conversations re-imports nothing, and Done says what came in', async () => {
    const recent = {
      id: 'a',
      harness: 'claude',
      project: '/work/shop',
      preview: 'conversation a',
      lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
      turns: 3,
    };
    const screen = await render({
      routes: {
        ...freshRoutes(CLAUDE_RUNTIME),
        '/v1/fleet/setup/scan': scan({
          runtimes: [],
          duplicates: [{ harness: 'claude', existing: 'claude-default', suggested: 'claude-default-2' }],
        }),
        '/v1/imports/conversations?harness=claude&limit=5000': { conversations: [recent], matched: 1, skipped: 0 },
        '/v1/imports/conversations/adopt': {
          adopted: [{ id: 'a', session: 's-a', name: 'ferret-a', status: 'stopped' }],
          refused: [],
        },
      },
      machine: FRESH_MACHINE,
    });
    await screen.rail('claude');
    await screen.click('[data-harness-conversations]');
    await screen.click('[data-onboarding-primary="import"]');
    expect(screen.at()).toBe('codex');
    expect(screen.q('[data-setup-note="import-carry"]')).toBeNull();
    expect(screen.calls.some(call => call.path === '/v1/fleet/proposals')).toBe(false);
    await finished(screen);
    expect(screen.text('[data-onboarding-notes]')).toBe('Brought in 1 conversation.');
  });

  it('a revisit whose conversations import was refused is carried as a warning, not “already set up” in green', async () => {
    const screen = await render({
      routes: {
        ...freshRoutes(CLAUDE_RUNTIME),
        '/v1/fleet/setup/scan': scan({
          runtimes: [],
          duplicates: [{ harness: 'claude', existing: 'claude-default', suggested: 'claude-default-2' }],
        }),
        '/v1/imports/conversations?harness=claude&limit=5000': new Error('offline'),
      },
      machine: FRESH_MACHINE,
    });
    await screen.rail('claude');
    await screen.click('[data-harness-conversations]');
    await screen.click('[data-onboarding-primary="import"]');
    const note = must(screen.q('[data-setup-note="import-carry"]'), 'the carried note');
    expect(note.getAttribute('data-tone')).toBe('warn');
    expect(note.textContent).toContain('Couldn’t bring in your Claude Code conversations');
  });

  describe('Done’s “still needs a sign-in” notes', () => {
    const stateOfLogin = (status: 'needs_sign_in' | 'ready') =>
      runtimes([runtimeView('claude-default', { credential: { id: 'claude-work', store: 'ferretry', status } })]);

    /** Imports Claude Code while its login needs a sign-in, then Done reads the machine as `later` says. */
    const importThenDone = async (later: 'needs_sign_in' | 'ready') => {
      let phase: 'before' | 'imported' | 'later' = 'before';
      const screen = await fresh(
        () => (phase === 'before' ? NO_RUNTIMES : stateOfLogin(phase === 'imported' ? 'needs_sign_in' : later)),
        {},
        {
          '/v1/fleet/proposals': STAGED,
          [APPLY_PATH]: { outcome: 'executed', executor: 'setup', summary: 'Imported' },
        },
      );
      await screen.rail('claude');
      phase = 'imported';
      await screen.click('[data-onboarding-primary="import"]');
      expect(screen.q('[data-carry-sign-in]')).not.toBeNull();
      phase = 'later';
      await finished(screen);
      return screen;
    };

    it('are said while the machine still reports the login as needing one', async () => {
      const screen = await importThenDone('needs_sign_in');
      expect(screen.view.container.textContent).toContain(
        'claude-default still needs a sign-in (Settings › Sign-ins).',
      );
    });

    it('go away once the login was signed in later, read from the machine when Done opens', async () => {
      const screen = await importThenDone('ready');
      expect(screen.q('[data-onboarding-summary]')).not.toBeNull();
      expect(screen.view.container.textContent).not.toContain('still needs a sign-in');
    });
  });

  it('stays on the page, and does not set the step, when the import is refused', async () => {
    const screen = await fresh(
      NO_RUNTIMES,
      {},
      {
        '/v1/fleet/proposals': STAGED,
        [APPLY_PATH]: new Error('The machine said no.'),
      },
    );
    await screen.rail('claude');
    await screen.click('[data-onboarding-primary="import"]');
    expect(screen.at()).toBe('claude');
    expect(stateOf(screen, 'claude')).toBe('todo');
    expect(screen.q('[data-setup-note="import-carry"]')).toBeNull();
    expect(screen.q('[data-change-refusal]')).not.toBeNull();
  });

  it('keeps a Continue on an imported step set, and moves on with no carried note', async () => {
    const screen = await fresh(CLAUDE_RUNTIME);
    await screen.rail('claude');
    expect(screen.q('[data-onboarding-next]')).toBeNull();
    await screen.click('[data-onboarding-primary="continue"]');
    expect(screen.at()).toBe('codex');
    expect(stateOf(screen, 'claude')).toBe('done');
    expect(screen.q('[data-setup-note="import-carry"]')).toBeNull();
  });

  it('offers Import, not Continue, on a CLI step that was not imported; Skip is how it is passed over', async () => {
    const screen = await fresh();
    await screen.rail('claude');
    expect(screen.text('[data-onboarding-primary]')).toBe('Import');
    expect(screen.q('[data-onboarding-next]')).toBeNull();
    await screen.click('[data-onboarding-skip]');
    expect(screen.at()).toBe('codex');
    expect(stateOf(screen, 'claude')).toBe('skipped');
    await screen.click('[data-onboarding-skip]');
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
    await screen.click('[data-harness-name-change]');
    const field = must(screen.q('[data-harness-name="claude"]') as HTMLInputElement | null, 'name field');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, ' my-claude ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(store.saves.at(-1)?.answers).toEqual({ claude: { name: 'my-claude' } });
    await screen.rail('speedups');
    expect(screen.q('[data-harness-runtime-line]')).toBeNull();
    await screen.rail('claude');
    expect(screen.text('[data-harness-runtime-line]')).toContain('my-claude');
    // the other CLI's step keeps its own answers
    await screen.rail('codex');
    expect(screen.text('[data-harness-runtime-line]')).toContain('codex-default');
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
    expect(screen.text('[data-harness-runtime-line]')).toContain('codex-mine');
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

// ── One action per page, however the person moves ────────────────────────────────────────────────

const primaries = (screen: Screen) =>
  screen.all('button[data-variant="primary"]').map(button => button.textContent?.trim() ?? '');

const typeInto = async (element: Element | null, value: string, what: string): Promise<void> => {
  const input = must(element as HTMLInputElement | null, what);
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};

describe('MachineOnboarding · an import that finishes after the person has moved on', () => {
  /** A machine whose apply waits until `release()`, so the person can move while Import is pending. */
  const held = () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let imported = false;
    const target = daemon({
      ...SET_UP_READS,
      '/v1/fleet/machine': FRESH_MACHINE,
      'GET /v1/fleet/runtimes': () => (imported ? CLAUDE_RUNTIME : NO_RUNTIMES),
      '/v1/fleet/proposals': STAGED,
      [APPLY_PATH]: () => {
        imported = true;
        return { outcome: 'executed', executor: 'setup', summary: 'Imported' };
      },
    });
    const client: FleetClient = {
      request: async (path, schema, init) => {
        if (path === APPLY_PATH) await gate;
        return await target.request(path, schema, init);
      },
    };
    return { client, release: () => release() };
  };
  const stateOf = (screen: Screen, id: string) =>
    screen.all(`[data-onboarding-rail="column"] [data-onboarding-go="${id}"]`)[0]?.getAttribute('data-state');

  it('does not skip the page the person moved to: Skip to Codex, then Import lands, and Codex is still open', async () => {
    const pending = held();
    const screen = await render({ machine: FRESH_MACHINE, createClient: async () => pending.client });
    await screen.rail('claude');
    await screen.click('[data-onboarding-primary="import"]');
    await screen.click('[data-onboarding-skip]');
    expect(screen.at()).toBe('codex');
    pending.release();
    await settle();
    expect(screen.at()).toBe('codex');
    expect(screen.q('[data-onboarding-step-body="codex"]')).not.toBeNull();
    expect(stateOf(screen, 'codex')).not.toBe('skipped');
  });

  it('still counts the import it did as Claude Code set, and carries nothing to the page after', async () => {
    const pending = held();
    const screen = await render({ machine: FRESH_MACHINE, createClient: async () => pending.client });
    await screen.rail('claude');
    await screen.click('[data-onboarding-primary="import"]');
    await screen.click('[data-onboarding-skip]');
    pending.release();
    await settle();
    expect(stateOf(screen, 'claude')).toBe('done');
    expect(screen.q('[data-setup-note="import-carry"]')).toBeNull();
  });

  it('does not move a person who went Back, or jumped by the rail, to a page they did not choose', async () => {
    const pending = held();
    const screen = await render({ machine: FRESH_MACHINE, createClient: async () => pending.client });
    await screen.rail('claude');
    await screen.click('[data-onboarding-primary="import"]');
    await screen.rail('warden');
    pending.release();
    await settle();
    expect(screen.at()).toBe('warden');
  });

  it('does not move a person who left and came back to the same step: the new visit is not the one that asked', async () => {
    const pending = held();
    const screen = await render({ machine: FRESH_MACHINE, createClient: async () => pending.client });
    await screen.rail('claude');
    await screen.click('[data-onboarding-primary="import"]');
    await screen.rail('warden');
    await screen.rail('claude');
    pending.release();
    await settle();
    expect(screen.at()).toBe('claude');
  });

  it('still moves on by itself when the person stayed', async () => {
    const pending = held();
    const screen = await render({ machine: FRESH_MACHINE, createClient: async () => pending.client });
    await screen.rail('claude');
    await screen.click('[data-onboarding-primary="import"]');
    pending.release();
    await settle();
    expect(screen.at()).toBe('codex');
  });
});

describe('MachineOnboarding · the page’s one primary', () => {
  it('keeps Continue as the one primary on Agent controls until a switch is flipped', async () => {
    const screen = await render();
    await screen.rail('controls');
    expect(primaries(screen)).toHaveLength(1);
    expect(screen.q('[data-onboarding-foot] button[data-variant="primary"]')).not.toBeNull();
  });

  it('turns Continue into Save and continue when a switch is flipped: no Save of its own in the body', async () => {
    const screen = await render();
    await screen.rail('controls');
    await screen.click('[data-agent-control] [role=switch]');
    expect(primaries(screen)).toEqual(['Save and continue']);
    expect(screen.q('[data-onboarding-foot] [data-onboarding-next="save"]')).not.toBeNull();
    expect(screen.q('[data-onboarding-step-body="controls"] [data-change-submit]')).toBeNull();
    expect(screen.q('[data-agent-control-undo]')).not.toBeNull();
  });

  it('Save and continue sends the change, reads the machine again and moves on', async () => {
    const screen = await render({
      routes: {
        ...SET_UP_READS,
        '/v1/fleet/machine': machineAnswer(),
        '/v1/fleet/proposals': STAGED,
        [APPLY_PATH]: { outcome: 'executed', executor: 'setup', summary: 'Saved' },
      },
    });
    await screen.rail('controls');
    await screen.click('[data-agent-control] [role=switch]');
    await screen.click('[data-onboarding-next="save"]');
    const proposed = screen.calls.find(call => call.path === '/v1/fleet/proposals');
    expect(proposed?.body).toMatchObject({ change: { kind: 'machine.settings' } });
    expect(screen.left.retried).toBe(1);
    expect(screen.at()).toBe('done');
  });

  it('stays on Agent controls and says why when the save is refused', async () => {
    const screen = await render({
      routes: {
        ...SET_UP_READS,
        '/v1/fleet/machine': machineAnswer(),
        '/v1/fleet/proposals': STAGED,
        [APPLY_PATH]: new Error('The machine said no.'),
      },
    });
    await screen.rail('controls');
    await screen.click('[data-agent-control] [role=switch]');
    await screen.click('[data-onboarding-next="save"]');
    expect(screen.at()).toBe('controls');
    expect(screen.q('[data-change-refusal]')).not.toBeNull();
    expect(screen.left.retried).toBe(0);
  });

  it('gives Continue its primary back when the switch is put back', async () => {
    const screen = await render();
    await screen.rail('controls');
    await screen.click('[data-agent-control] [role=switch]');
    await screen.click('[data-agent-control] [role=switch]');
    expect(primaries(screen)).toHaveLength(1);
    expect(screen.q('[data-onboarding-foot] button[data-variant="primary"]')).not.toBeNull();
  });

  describe('with a switch flipped AND a different default runtime picked', () => {
    const bothPending = async () => {
      const screen = await render({
        routes: {
          ...SET_UP_READS,
          'GET /v1/fleet/runtimes': CLAUDE_RUNTIME,
          '/v1/fleet/machine': machineAnswer({ mayApply: false, applyRefusal: 'step-up-required' }),
        },
        machine: machineView({ defaultRuntime: null, runtimeCount: 1 }),
      });
      await screen.rail('controls');
      await screen.click('[data-agent-control] [role=switch]');
      const select = must(screen.q('[data-default-runtime-select]') as HTMLSelectElement | null, 'runtime select');
      await interact(() => {
        select.value = 'claude-default';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await settle();
      return screen;
    };

    it('shows exactly one primary, Save and continue, and says the passkey line once', async () => {
      const screen = await bothPending();
      expect(primaries(screen)).toEqual(['Save and continue']);
      expect(screen.all('form [data-change-submit]')).toHaveLength(0);
      expect(screen.all('[data-change-step-up]')).toHaveLength(1);
    });

    it('saves both edits as ONE change, so neither undoes the other', async () => {
      const screen = await bothPending();
      await screen.click('[data-onboarding-next="save"]');
      const proposed = screen.calls.filter(call => call.path === '/v1/fleet/proposals');
      expect(proposed).toHaveLength(1);
      expect(proposed[0]?.body).toMatchObject({
        change: { kind: 'machine.settings', defaultRuntime: 'claude-default', agentControl: { terminals: false } },
      });
    });

    it('keeps Save and continue while one edit is left, after the other is undone', async () => {
      const screen = await bothPending();
      await screen.click('[data-agent-control-undo]');
      expect(primaries(screen)).toEqual(['Save and continue']);
    });

    it('gives the footer its primary back once both are undone', async () => {
      const screen = await bothPending();
      await screen.click('[data-agent-control-undo]');
      await screen.click('[data-default-runtime-undo]');
      expect(primaries(screen)).toHaveLength(1);
      expect(screen.q('[data-onboarding-foot] button[data-variant="primary"]')).not.toBeNull();
    });
  });
});

describe('MachineOnboarding · an open provider-key form', () => {
  const secretsRoute = (call: Call) =>
    call.body === undefined
      ? { v: 1, health: 'ready', secrets: [], references: [] }
      : {
          name: (call.body as { name: string }).name,
          createdAt: '2026-10-16T08:00:00.000Z',
          updatedAt: '2026-10-16T08:00:00.000Z',
        };
  const providerScreen = () =>
    render({
      machine: FRESH_MACHINE,
      routes: {
        ...SET_UP_READS,
        '/v1/fleet/machine': FRESH_MACHINE,
        '/v1/fleet/presets': PROVIDERS,
        '/v1/secrets': secretsRoute,
      },
    });
  const footerImport = (screen: Screen) =>
    must(screen.q('[data-onboarding-foot] [data-onboarding-primary="import"]'), 'the footer Import');

  it('keeps Import the footer’s one primary while only the provider grid is open', async () => {
    const screen = await providerScreen();
    await screen.rail('claude');
    await screen.click('[data-harness-provider-toggle]');
    expect(screen.q('[data-provider-grid]')).not.toBeNull();
    expect(footerImport(screen).getAttribute('data-variant')).toBe('primary');
    expect(primaries(screen)).toEqual(['Import']);
  });

  it('puts a provider form’s Add in the footer in place of Import, and gives Import back when the form closes', async () => {
    const screen = await providerScreen();
    await screen.rail('claude');
    await screen.click('[data-harness-provider-toggle]');
    await screen.click('[data-provider-tile="deepseek"]');
    expect(screen.q('[data-env-login="form"]')).not.toBeNull();
    // One main action: the form's Add, in the footer. Import is not shown beside it.
    expect(primaries(screen)).toEqual(['Add']);
    expect(screen.q('[data-onboarding-foot] [data-onboarding-primary="change"]')?.textContent).toBe('Add');
    expect(screen.q('[data-env-login="form"] [data-change-submit]')).toBeNull();
    expect(screen.q('[data-onboarding-primary="import"]')).toBeNull();
    await screen.click('[data-harness-provider-toggle]');
    expect(screen.q('[data-env-login="form"]')).toBeNull();
    expect(footerImport(screen).getAttribute('data-variant')).toBe('primary');
    expect(primaries(screen)).toEqual(['Import']);
  });
});

describe('MachineOnboarding · sign-in and a provider key together', () => {
  const SIGNED_OUT = scan({
    harnesses: scan().harnesses.map(entry => ({ ...entry, account: { state: 'not-signed-in' as const } })),
  });
  const screenWith = (extra: Record<string, unknown> = {}) =>
    render({
      machine: FRESH_MACHINE,
      routes: {
        ...SET_UP_READS,
        '/v1/fleet/machine': FRESH_MACHINE,
        '/v1/fleet/setup/scan': SIGNED_OUT,
        '/v1/fleet/presets': PROVIDERS,
        '/v1/secrets': (call: Call) =>
          call.body === undefined
            ? { v: 1, health: 'ready', secrets: [], references: [] }
            : {
                name: (call.body as { name: string }).name,
                createdAt: '2026-10-16T08:00:00.000Z',
                updatedAt: '2026-10-16T08:00:00.000Z',
              },
        ...extra,
      },
    });
  const KEY = '[data-env-secret-input="DEEPSEEK_API_KEY"]';
  const typedKey = (screen: Screen) => (screen.q(KEY) as HTMLInputElement | null)?.value;
  const openForm = async (screen: Screen): Promise<void> => {
    await screen.click('[data-harness-provider-toggle]');
    await screen.click('[data-provider-tile="deepseek"]');
    await typeInto(screen.q(KEY), 'sk-deepseek-typed', 'the key');
  };
  const signInSubmit = (screen: Screen) =>
    must(screen.q('[data-first-run-sign-in] [data-change-submit]') as HTMLButtonElement | null, 'the sign-in button');

  for (const [harness, name] of [
    ['claude', 'Claude Code'],
    ['codex', 'Codex'],
  ] as const) {
    it(`${name}: a key form opened first keeps the one primary; the sign-in steps back, still works, and nothing typed is lost`, async () => {
      const screen = await screenWith({
        '/v1/fleet/proposals': STAGED,
        [APPLY_PATH]: { outcome: 'executed', executor: 'setup', summary: 'ok' },
      });
      await screen.rail(harness);
      await openForm(screen);
      await screen.click('[data-harness-sign-in]');
      expect(screen.q(`[data-first-run-sign-in="${harness}"]`)).not.toBeNull();
      expect(primaries(screen)).toEqual(['Add']);
      const quiet = signInSubmit(screen);
      expect(quiet.textContent).toBe(`Sign in to ${name}`);
      expect(quiet.disabled).toBe(false);
      expect(typedKey(screen)).toBe('sk-deepseek-typed');
      await screen.click('[data-first-run-sign-in] [data-change-submit]');
      expect(screen.calls.some(call => call.path === '/v1/fleet/proposals' || call.path === '/v1/fleet/login')).toBe(
        true,
      );
      expect(primaries(screen)).toEqual(['Add']);
      await screen.click('[data-first-run-sign-in-close]');
      expect(screen.q('[data-first-run-sign-in]')).toBeNull();
      expect(primaries(screen)).toEqual(['Add']);
      expect(typedKey(screen)).toBe('sk-deepseek-typed');
    });

    it(`${name}: a sign-in opened first keeps the one primary; the key form steps back, and takes it when the sign-in closes`, async () => {
      const screen = await screenWith();
      await screen.rail(harness);
      await screen.click('[data-harness-sign-in]');
      expect(primaries(screen)).toEqual([`Sign in to ${name}`]);
      await openForm(screen);
      expect(primaries(screen)).toEqual([`Sign in to ${name}`]);
      const add = must(screen.q('[data-env-login="form"] [data-change-submit]') as HTMLButtonElement | null, 'Add');
      expect(add.disabled).toBe(false);
      expect(typedKey(screen)).toBe('sk-deepseek-typed');
      await screen.click('[data-first-run-sign-in-close]');
      expect(primaries(screen)).toEqual(['Add']);
      expect(typedKey(screen)).toBe('sk-deepseek-typed');
    });
  }
});

describe('MachineOnboarding · Save keys that finish after the person has moved on', () => {
  it('keeps the page the person moved to, and still counts Speed-ups as set', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const name = (call: Call) => (call.body as { name: string }).name;
    const target = daemon({
      ...SET_UP_READS,
      '/v1/speedups': speedups(false),
      '/v1/secrets': (call: Call) => ({
        name: name(call),
        createdAt: '2026-10-16T08:00:00.000Z',
        updatedAt: '2026-10-16T08:00:00.000Z',
      }),
      '/v1/speedups/jev/test': {
        provider: 'jev',
        secretName: 'JEV_API_KEY',
        ok: true,
        code: 'ok',
        message: 'The key works.',
        at: '2026-01-01T00:00:00.000Z',
      },
    });
    const client: FleetClient = {
      request: async (path, schema, init) => {
        if (path === '/v1/speedups/jev/test') await gate;
        return await target.request(path, schema, init);
      },
    };
    const screen = await render({ createClient: async () => client });
    await screen.rail('speedups');
    await typeInto(screen.q('#speedup-key-jev'), 'sk-test-0123456789', 'the Jev field');
    await screen.click('[data-onboarding-primary="save-keys"]');
    await screen.click('[data-onboarding-skip]');
    expect(screen.at()).toBe('voice');
    release();
    await settle();
    expect(screen.at()).toBe('voice');
    const state = screen
      .all('[data-onboarding-rail="column"] [data-onboarding-go="speedups"]')[0]
      ?.getAttribute('data-state');
    expect(state).toBe('done');
  });
});
