import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { MachineSetupScreen } from '../../../../../src/features/fleet/setup/setup-screen.tsx';
import {
  readSetupProgress,
  SETUP_PROGRESS_KEY,
  writeSetupProgress,
} from '../../../../../src/features/fleet/setup/setup-progress.ts';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { pairing } from '../shell/machine-support.ts';
import { FRESH_MACHINE, machineView, runtimes, scan, scriptedClient } from './setup-support.ts';

const studio = pairing('studio', 'studio mac');

const memory = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (k: string, v: string) => values.set(k, v) };
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  });
};

const freshClient = (): FleetClient =>
  scriptedClient({
    '/v1/fleet/machine': FRESH_MACHINE,
    '/v1/fleet/setup/scan': scan({ tools: scan().tools }),
    '/v1/fleet/runtimes': runtimes([]),
  });

interface Screen {
  readonly view: Mounted;
  readonly went: string[];
  readonly q: (selector: string) => Element | null;
  readonly click: (selector: string) => Promise<void>;
}

const open = async (
  client: FleetClient | (() => Promise<FleetClient>),
  storage: ReturnType<typeof memory> | null = memory(),
): Promise<Screen> => {
  const went: string[] = [];
  const view = await mount(
    <MachineSetupScreen
      connection={studio}
      connections={[studio]}
      createClient={typeof client === 'function' ? client : async () => client}
      onNavigate={to => went.push(to)}
      storage={storage}
    />,
  );
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

const step = (screen: Screen): string | null | undefined =>
  screen.q('[data-first-run-step]')?.getAttribute('data-first-run-step');

describe('MachineSetupScreen', () => {
  it('says it is checking the machine until it answers', async () => {
    const screen = await open(() => new Promise<FleetClient>(() => undefined));
    expect(screen.q('[data-setup-message] h1')?.textContent).toBe('Checking studio mac…');
    await screen.view.unmount();
  });

  it('runs the first run full screen, and Finish later goes back to the machine with the step kept', async () => {
    const storage = memory();
    const screen = await open(freshClient(), storage);
    expect(screen.q('[data-machine-setup]')).not.toBeNull();
    expect(screen.q('[data-machine-stepper="first-run"]')?.getAttribute('data-presentation')).toBe('screen');
    expect(step(screen)).toBe('tools');
    await screen.click('[data-step-next]');
    expect(step(screen)).toBe('claude');
    await screen.click('[data-harness-import]');
    expect(step(screen)).toBe('codex');
    expect(readSetupProgress(storage, studio.daemonId)).toEqual({
      at: 'codex',
      answers: { choices: { claude: 'import' }, names: {}, make: {}, accepted: [] },
    });
    await screen.click('[data-stepper-finish-later]');
    expect(screen.went).toEqual(['/d/studio/settings#machines/studio%20mac/runtimes']);
    await screen.view.unmount();

    // Coming back resumes on that step, with the answer it had.
    const again = await open(freshClient(), storage);
    expect(step(again)).toBe('codex');
    await again.click('[data-stepper-back]');
    expect(step(again)).toBe('claude');
    await again.view.unmount();
  });

  it('starts from the top when the kept step no longer exists, and forgets the progress once done', async () => {
    const storage = memory();
    writeSetupProgress(storage, studio.daemonId, {
      at: 'names',
      answers: { choices: {}, names: {}, make: {}, accepted: [] },
    });
    const screen = await open(freshClient(), storage);
    // Nothing was chosen to import, so there is no Name step to return to.
    expect(step(screen)).toBe('tools');
    await screen.click('[data-step-next]');
    await screen.click('[data-harness-skip]');
    await screen.click('[data-harness-skip]');
    expect(screen.q('[data-first-run-result="nothing"]')).not.toBeNull();
    expect(storage.values.get(SETUP_PROGRESS_KEY)).toBe('{}');
    await screen.click('[data-first-run-finish]');
    expect(screen.went).toEqual(['/d/studio/settings#machines/studio%20mac/runtimes']);
    await screen.view.unmount();
  });

  it('works without storage: it only cannot resume', async () => {
    const screen = await open(freshClient(), null);
    expect(step(screen)).toBe('tools');
    await screen.view.unmount();
  });

  it('says a machine that is already set up is, and offers its sessions or Settings', async () => {
    const screen = await open(scriptedClient({ '/v1/fleet/machine': machineView() }));
    expect(screen.q('[data-setup-message] h1')?.textContent).toBe('studio mac is already set up');
    expect(screen.q('[data-machine-stepper]')).toBeNull();
    const [sessions, settings] = [...screen.view.container.querySelectorAll<HTMLButtonElement>('[data-setup-message] button')];
    await interact(() => must(sessions, 'sessions').click());
    await interact(() => must(settings, 'settings').click());
    expect(screen.went).toEqual(['/d/studio', '/d/studio/settings#machines/studio%20mac/runtimes']);
    await screen.view.unmount();
  });

  it('says why it cannot set up a machine that would not share its setup', async () => {
    const screen = await open(
      scriptedClient({ '/v1/fleet/machine': new FyHttpError('older daemon', 404, 'not_found') }),
    );
    expect(screen.q('[data-setup-message] h1')?.textContent).toBe('Can’t set up studio mac here');
    expect(screen.q('[data-setup-message] p')?.textContent).toContain('older Ferretry');
    await screen.click('[data-setup-message] button');
    expect(screen.went).toEqual(['/d/studio/settings#machines/studio%20mac/runtimes']);
    await screen.view.unmount();
  });

  it('pauses on a machine that is asleep, and Retry asks it again', async () => {
    let asked = 0;
    const screen = await open(async () => {
      asked += 1;
      return scriptedClient({});
    });
    expect(screen.q('[data-stepper-paused]')).not.toBeNull();
    const before = asked;
    await screen.click('[data-stepper-retry]');
    expect(asked).toBeGreaterThan(before);
    await screen.view.unmount();
  });
});
