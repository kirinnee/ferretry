import { afterEach, describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { type MachineSetupStepId, ONBOARDING_START } from '../../../../../src/features/fleet/setup/onboarding-model.ts';
import {
  MACHINE_SETUP_PROGRESS_KEY,
  readMachineSetupProgress,
  writeMachineSetupProgress,
} from '../../../../../src/features/fleet/setup/setup-progress.ts';
import { MachineSetupScreen } from '../../../../../src/features/fleet/setup/setup-screen.tsx';
import type { DaemonConnectionRecord } from '../../../../../src/lib/connections.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { CREDENTIALS, PROFILES } from '../account-support.ts';
import { pairing } from '../shell/machine-support.ts';
import { FRESH_MACHINE, machineView, runtimes, scan, scriptedClient } from './setup-support.ts';

const studio = pairing('studio', 'studio mac');
const work = pairing('work', 'work linux');

const memory = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  };
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  });
};

/** The reads the Claude Code and Codex steps make, on top of the machine itself: no runtime yet. */
const stepReads = {
  '/v1/fleet/credentials': CREDENTIALS,
  '/v1/fleet/runtimes': runtimes([]),
  '/v1/fleet/profiles': PROFILES,
};

const freshClient = (): FleetClient =>
  scriptedClient({
    '/v1/fleet/machine': FRESH_MACHINE,
    '/v1/fleet/setup/scan': scan({ tools: scan().tools }),
    ...stepReads,
  });

const setUpClient = (): FleetClient => scriptedClient({ '/v1/fleet/machine': machineView(), ...stepReads });

interface Screen {
  readonly view: Mounted;
  readonly went: string[];
  readonly q: (selector: string) => Element | null;
  readonly click: (selector: string) => Promise<void>;
}

const mounted: Mounted[] = [];

afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

const open = async (
  client: FleetClient | (() => Promise<FleetClient>),
  storage: ReturnType<typeof memory> | null = memory(),
  connections: readonly DaemonConnectionRecord[] = [studio],
  startAt?: MachineSetupStepId,
): Promise<Screen> => {
  const went: string[] = [];
  const view = await mount(
    <MachineSetupScreen
      connection={studio}
      connections={connections}
      createClient={typeof client === 'function' ? client : async () => client}
      onNavigate={to => went.push(to)}
      storage={storage}
      {...(startAt === undefined ? {} : { startAt })}
    />,
  );
  mounted.push(view);
  await settle();
  const q = (selector: string) => view.container.querySelector(selector);
  return {
    view,
    went,
    q,
    click: async selector => {
      const element = must(q(selector) as HTMLElement | null, selector);
      await interact(() => element.click());
      await settle();
    },
  };
};

const at = (screen: Screen): string | null | undefined =>
  screen.q('[data-machine-onboarding]')?.getAttribute('data-onboarding-at');

describe('MachineSetupScreen', () => {
  it('says it is checking the machine until it answers', async () => {
    const screen = await open(() => new Promise<FleetClient>(() => undefined));
    expect(screen.q('[data-setup-message] h1')?.textContent).toBe('Checking studio mac…');
    expect(screen.q('[data-machine-onboarding]')).toBeNull();
  });

  it('opens the onboarding on its first real choice, with this machine’s name', async () => {
    const screen = await open(freshClient());
    expect(screen.q('[data-machine-setup]')).not.toBeNull();
    expect(screen.q('[data-machine-onboarding="studio"]')).not.toBeNull();
    expect(at(screen)).toBe('start');
    expect(screen.q('#machine-onboarding-title')?.textContent).toBe('Start from…');
    expect(screen.q('[data-machine-setup] p.kt-label')?.textContent).toContain('studio mac');
  });

  it('opens the onboarding for a machine that is already set up, with Claude Code one tap away', async () => {
    const screen = await open(setUpClient());
    expect(screen.q('[data-setup-message]')).toBeNull();
    expect(at(screen)).toBe('start');
    await screen.click('[data-onboarding-rail="column"] [data-onboarding-go="claude"]');
    expect(at(screen)).toBe('claude');
    expect(screen.q('[data-onboarding-step-body="claude"]')).not.toBeNull();
  });

  it('opens on the step it is told to, as Settings’ Import again does, over a kept place', async () => {
    const storage = memory();
    writeMachineSetupProgress(storage, studio.daemonId, { ...ONBOARDING_START, at: 'warden' });
    const screen = await open(setUpClient(), storage, [studio], 'claude');
    expect(at(screen)).toBe('claude');
    expect(screen.q('#machine-onboarding-title')?.textContent).toBe('Claude Code');
    expect(readMachineSetupProgress(storage, studio.daemonId)?.at).toBe('claude');
  });

  it('opens on the step it is told to when nothing was kept', async () => {
    const screen = await open(freshClient(), memory(), [studio], 'codex');
    expect(at(screen)).toBe('codex');
    expect(screen.q('[data-onboarding-step-body="codex"]')).not.toBeNull();
  });

  it('keeps the rail’s place per daemon in storage, and resumes there', async () => {
    const storage = memory();
    const screen = await open(freshClient(), storage);
    await screen.click('[data-onboarding-next]');
    expect(at(screen)).toBe('claude');
    expect(readMachineSetupProgress(storage, studio.daemonId)).toEqual({
      at: 'claude',
      states: { pair: 'done', start: 'done' },
      start: 'fresh',
    });
    expect(Object.keys(JSON.parse(storage.values.get(MACHINE_SETUP_PROGRESS_KEY) ?? '{}'))).toEqual(['studio']);
    await screen.view.unmount();
    mounted.length = 0;

    const again = await open(freshClient(), storage);
    expect(at(again)).toBe('claude');
    expect(again.q('[data-onboarding-count]')?.textContent).toBe('2 of 9 set');
  });

  it('keeps another daemon’s place separate', async () => {
    const storage = memory();
    writeMachineSetupProgress(storage, work.daemonId, { ...ONBOARDING_START, at: 'warden' });
    const screen = await open(freshClient(), storage);
    expect(at(screen)).toBe('start');
    expect(readMachineSetupProgress(storage, work.daemonId)?.at).toBe('warden');
  });

  it('keeps the runtime name typed on a CLI step with the place, under the one version 2 key', async () => {
    const storage = memory();
    const screen = await open(freshClient(), storage);
    await screen.click('[data-onboarding-rail="column"] [data-onboarding-go="codex"]');
    const field = must(screen.q('[data-harness-name="codex"]') as HTMLInputElement | null, 'name field');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'codex-mine');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(readMachineSetupProgress(storage, studio.daemonId)?.answers).toEqual({ codex: { name: 'codex-mine' } });
    expect([...storage.values.keys()]).toEqual([MACHINE_SETUP_PROGRESS_KEY]);
    await screen.view.unmount();
    mounted.length = 0;

    const again = await open(freshClient(), storage);
    expect(at(again)).toBe('codex');
    expect((again.q('[data-harness-name="codex"]') as HTMLInputElement).value).toBe('codex-mine');
  });

  it('does not resume a place kept by the old rail’s own key', async () => {
    const storage = memory();
    storage.values.set(
      'fy-onboarding-progress',
      JSON.stringify({ studio: { at: 'logins', states: { pair: 'done' }, start: 'fresh' } }),
    );
    const screen = await open(freshClient(), storage);
    expect(at(screen)).toBe('start');
  });

  it('works without storage: it only cannot resume', async () => {
    const screen = await open(freshClient(), null);
    expect(at(screen)).toBe('start');
    await screen.click('[data-onboarding-next]');
    expect(at(screen)).toBe('claude');
  });

  it('Finish later goes back to the machine, and the place is kept', async () => {
    const storage = memory();
    const screen = await open(freshClient(), storage);
    await screen.click('[data-onboarding-later-all]');
    expect(screen.went).toEqual(['/d/studio/settings#machines/studio%20mac/machine']);
    expect(readMachineSetupProgress(storage, studio.daemonId)).toEqual(ONBOARDING_START);
  });

  it('Finish setup goes to the machine’s sessions and forgets the place', async () => {
    const storage = memory();
    const screen = await open(freshClient(), storage);
    await screen.click('[data-onboarding-rail="column"] [data-onboarding-go="done"]');
    await screen.click('[data-onboarding-finish]');
    expect(screen.went).toEqual(['/d/studio']);
    expect(readMachineSetupProgress(storage, studio.daemonId)).toBeNull();
  });

  it('offers every OTHER paired machine to clone from, never this one', async () => {
    const screen = await open(freshClient(), memory(), [studio, work]);
    await screen.click('[data-setup-choice="clone"] input');
    expect(screen.q('[data-setup-choice="work"]')).not.toBeNull();
    expect(screen.q('[data-setup-choice="studio"]')).toBeNull();
  });

  it('says why it cannot set up a machine that would not share its setup, and Open in Settings goes to it', async () => {
    const screen = await open(
      scriptedClient({ '/v1/fleet/machine': new FyHttpError('older daemon', 404, 'not_found') }),
    );
    expect(screen.q('[data-setup-message] h1')?.textContent).toBe('Can’t set up studio mac here');
    expect(screen.q('[data-setup-message] p')?.textContent).toContain('older Ferretry');
    expect(screen.q('[data-machine-onboarding]')).toBeNull();
    await screen.click('[data-setup-message] button');
    expect(screen.went).toEqual(['/d/studio/settings#machines/studio%20mac/machine']);
  });

  it('still renders the onboarding when the machine is asleep, paused inside the steps that need it', async () => {
    let asked = 0;
    const screen = await open(async () => {
      asked += 1;
      return scriptedClient({});
    });
    expect(screen.q('[data-setup-message]')).toBeNull();
    expect(screen.q('[data-machine-onboarding]')).not.toBeNull();
    await screen.click('[data-onboarding-rail="column"] [data-onboarding-go="claude"]');
    expect(screen.q('[data-setup-note="harness-paused"]')).not.toBeNull();
    await screen.click('[data-onboarding-rail="column"] [data-onboarding-go="start"]');
    await screen.click('[data-setup-choice="clone"] input');
    expect(screen.q('[data-stepper-paused]')).not.toBeNull();
    const before = asked;
    await screen.click('[data-stepper-retry]');
    expect(asked).toBeGreaterThan(before);
  });

  it('stays mounted, on the same step, when the machine is checked again after a step changes it', async () => {
    // The machine is checked again right after an import, and answers "checking" first.
    let imported = false;
    let release = (): void => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const client = scriptedClient({
      '/v1/fleet/machine': () => (imported ? machineView() : FRESH_MACHINE),
      '/v1/fleet/setup/scan': scan({ tools: scan().tools }),
      ...stepReads,
    });
    let held = false;
    const screen = await open(async () => {
      if (held) await gate;
      return client;
    });
    expect(at(screen)).toBe('start');
    await screen.click('[data-onboarding-next]');
    held = true;
    imported = true;
    await screen.click('[data-onboarding-rail="column"] [data-onboarding-go="speedups"]');
    await screen.click('[data-onboarding-rail="column"] [data-onboarding-go="claude"]');
    expect(screen.q('[data-setup-message]')).toBeNull();
    expect(at(screen)).toBe('claude');
    await interact(() => release());
    await settle();
    expect(at(screen)).toBe('claude');
  });
});
