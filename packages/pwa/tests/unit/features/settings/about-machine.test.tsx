import { afterEach, describe, expect, it } from 'bun:test';
import type { DaemonUpdateStartRequest, DaemonUpdateView } from '@ferretry/protocol';
import {
  type AboutClient,
  AboutMachineSurface,
  aboutSettingsTab,
} from '../../../../src/features/settings/about-machine.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { updateView } from './about-machine-support.ts';
import { type WhatsNewEntry, WhatsNewProvider } from '../../../../src/features/whats-new/whats-new-host.tsx';

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'device-a' });
const NOW = Date.parse('2026-10-18T12:00:00.000Z');

class HttpRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** A machine whose answers are queued; the last answer repeats. */
class FakeMachine implements AboutClient {
  readonly reads: (DaemonUpdateView | Error)[];
  readonly starts: DaemonUpdateStartRequest[] = [];
  readonly settings: boolean[] = [];
  startAnswers: (DaemonUpdateView | Error)[] = [];
  settingsAnswer: DaemonUpdateView | Error = updateView({ autoInstall: true });

  constructor(...reads: (DaemonUpdateView | Error)[]) {
    this.reads = reads;
  }

  async daemonUpdate(): Promise<DaemonUpdateView> {
    const next = this.reads.length > 1 ? this.reads.shift() : this.reads[0];
    if (next === undefined || next instanceof Error) throw next ?? new Error('no answer');
    return next;
  }

  async startDaemonUpdate(request: DaemonUpdateStartRequest): Promise<DaemonUpdateView> {
    this.starts.push(request);
    const next = this.startAnswers.shift();
    if (next === undefined || next instanceof Error) throw next ?? new Error('no answer');
    return next;
  }

  async updateDaemonUpdateSettings(patch: { autoInstall: boolean }): Promise<DaemonUpdateView> {
    this.settings.push(patch.autoInstall);
    if (this.settingsAnswer instanceof Error) throw this.settingsAnswer;
    return this.settingsAnswer;
  }
}

const settle = async (ms = 10): Promise<void> => {
  await interact(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
};

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const show = async (machine: FakeMachine, pollMs = 5, whatsNew: WhatsNewEntry | null = null): Promise<HTMLElement> => {
  const writes: string[] = [];
  mounted = await mount(
    <WhatsNewProvider value={whatsNew}>
      <AboutMachineSurface
        connection={connection}
        createClient={async () => machine}
        pollMs={pollMs}
        clock={() => NOW}
        write={async text => {
          writes.push(text);
        }}
      />
    </WhatsNewProvider>,
  );
  await settle();
  return mounted.container;
};

const click = async (container: HTMLElement, selector: string): Promise<void> => {
  const target = must(container.querySelector<HTMLElement>(selector), selector);
  await interact(() => target.click());
  await settle();
};

const buttonNamed = (container: HTMLElement, name: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name),
    `the ${name} button`,
  );

describe('AboutMachineSurface', () => {
  it('shows the machine, the app, the install method and the update', async () => {
    const container = await show(new FakeMachine(updateView()));
    const text = container.textContent ?? '';
    expect(text).toContain('Update available 4.28.0 → 4.29.0');
    expect(text).toContain('Latest release 4.29.0, checked 2 hours ago.');
    expect(container.querySelector('[data-about-daemon-version]')?.textContent).toBe('4.28.0');
    expect(container.querySelector('[data-about-app-version]')?.textContent).toBe('unknown');
    expect(container.querySelector('[data-about-method]')?.getAttribute('data-about-method')).toBe('homebrew');
    expect(container.querySelector('[data-about-version-pair]')?.getAttribute('data-about-version-pair')).toBe('pend');
    expect(container.querySelector('[data-about-changelog]')?.getAttribute('href')).toBe(
      'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0',
    );
    expect(text).toContain('cannot be undone on its own');
    expect(container.querySelector('[data-about-auto-install]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('starts an update, and restarts until the new daemon reports it finished', async () => {
    const running = updateView({
      job: { state: 'running', target: '4.29.0', startedAt: '2026-10-18T11:59:00.000Z' },
    });
    const finished = updateView({
      current: '4.29.0',
      available: false,
      job: {
        state: 'finished',
        report: {
          from: '4.28.0',
          target: '4.29.0',
          outcome: 'succeeded',
          message: 'Updated to 4.29.0.',
          finishedAt: '2026-10-18T12:00:00.000Z',
        },
      },
    });
    const machine = new FakeMachine(updateView(), new Error('the machine is restarting'), finished);
    machine.startAnswers = [running];
    const container = await show(machine);
    await click(container, '[data-about-update]');
    expect(machine.starts).toEqual([{ target: '4.29.0', when: 'now', confirmMidTurn: true }]);
    await settle(40);
    expect(container.querySelector('[data-about-job]')?.textContent).toBe('Updated to 4.29.0.');
    expect(container.querySelector('[data-about-update]')).toBeNull();
  });

  it('updates now with ferrets mid-turn, saying they keep running, and still offers Update when idle', async () => {
    const busy = updateView({ midTurn: 2 });
    const running = updateView({
      midTurn: 2,
      job: { state: 'running', target: '4.29.0', startedAt: '2026-10-18T11:59:00.000Z' },
    });
    const machine = new FakeMachine(busy, running);
    machine.startAnswers = [running];
    const container = await show(machine, 10_000);

    expect(container.querySelector('[data-about-mid-turn]')?.textContent).toBe(
      '2 ferrets are mid-turn. They keep running while the machine restarts.',
    );
    expect(buttonNamed(container, 'Update when idle')).toBeDefined();
    await click(container, '[data-about-update]');
    await settle();
    expect(machine.starts).toEqual([{ target: '4.29.0', when: 'now', confirmMidTurn: true }]);
    expect(container.querySelector('[data-about-mid-turn]')).toBeNull();
    expect(container.querySelector('[data-about-update-when-idle]')).toBeNull();
  });

  it('waits for idle when asked, and says it is waiting', async () => {
    const waiting = updateView({
      midTurn: 1,
      job: { state: 'waiting-for-idle', target: '4.29.0', requestedAt: '2026-10-18T12:00:00.000Z', midTurn: 1 },
    });
    const machine = new FakeMachine(updateView({ midTurn: 1 }), waiting);
    machine.startAnswers = [waiting];
    const container = await show(machine, 10_000);

    expect(container.querySelector('[data-about-mid-turn]')?.textContent).toBe(
      '1 ferret is mid-turn. It keeps running while the machine restarts.',
    );
    await interact(() => buttonNamed(container, 'Update when idle').click());
    await settle();
    expect(machine.starts).toEqual([{ target: '4.29.0', when: 'when-idle' }]);
    expect(container.querySelector('[data-about-job]')?.textContent).toContain('Waiting to update to 4.29.0');
  });

  it('says nothing about ferrets, and offers no wait, when none is mid-turn', async () => {
    const container = await show(new FakeMachine(updateView({ midTurn: 0 })));
    expect(container.querySelector('[data-about-mid-turn]')).toBeNull();
    expect(container.querySelector('[data-about-update-when-idle]')).toBeNull();
  });

  it('says what the daemon refused, and turns automatic install on', async () => {
    const machine = new FakeMachine(
      updateView({ plan: { kind: 'self', steps: [{ command: 'fy daemon update' }], rollback: 'automatic' } }),
    );
    machine.startAnswers = [new HttpRefusal('an update is already running', 409, 'update_in_progress')];
    const container = await show(machine);
    expect(container.textContent).toContain('the old one is put back on its own');
    await click(container, '[data-about-update]');
    expect(container.querySelector('[data-about-error]')?.textContent).toBe('an update is already running');
    await click(container, '[data-about-auto-install]');
    expect(machine.settings).toEqual([true]);
    expect(container.querySelector('[data-about-auto-install]')?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-about-auto-install]')?.textContent).toBe('On');
  });

  it('opens What’s new in the app and keeps the GitHub release as a secondary link when a host is mounted', async () => {
    let opened = 0;
    const container = await show(new FakeMachine(updateView()), 5, {
      open: () => (opened += 1),
      unread: true,
      latest: '4.29.0',
    });
    const button = must(container.querySelector<HTMLElement>('[data-about-whats-new]'), 'button');
    expect(button.textContent).toContain('What’s new');
    expect(container.querySelector('[data-about-whats-new-unread]')?.textContent).toBe('New');
    await interact(() => button.click());
    expect(opened).toBe(1);
    expect(container.querySelector('[data-about-changelog]')?.textContent).toContain('Full release on GitHub');
  });

  it('opens What’s new without a New badge once the latest entry has been read', async () => {
    const container = await show(new FakeMachine(updateView()), 5, {
      open: () => undefined,
      unread: false,
      latest: '4.29.0',
    });

    expect(container.querySelector('[data-about-whats-new]')?.textContent).toContain('What’s new');
    expect(container.querySelector('[data-about-whats-new-unread]')).toBeNull();
  });

  it('shows no Update button when the machine is current', async () => {
    const container = await show(new FakeMachine(updateView({ available: false, check: { state: 'never' } })));
    expect(container.querySelector('[data-about-update]')).toBeNull();
    expect(container.querySelector('[data-about-changelog]')).toBeNull();
  });

  it('explains a switch, which is not an update button, with its copyable steps', async () => {
    const container = await show(
      new FakeMachine(
        updateView({
          method: { kind: 'nix-shell', storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ferretry' },
          plan: {
            kind: 'switch',
            explanation: 'Install it into your nix profile.',
            steps: [
              { command: 'nix profile install github:kirinnee/ferretry' },
              { command: 'fy daemon install', note: 'from a new shell' },
            ],
          },
        }),
      ),
    );
    expect(container.querySelector('[data-about-plan="switch"]')?.textContent).toContain(
      'Switch to a nix profile install (at the machine)',
    );
    expect(container.querySelector('[data-about-update]')).toBeNull();
    expect(container.querySelectorAll('[data-about-steps] li').length).toBe(2);
    expect(container.textContent).toContain('from a new shell');
    expect(container.querySelector('[data-about-auto-install]')).toBeNull();
  });

  it('lists the manual steps for a method that cannot update itself', async () => {
    const container = await show(
      new FakeMachine(
        updateView({
          method: { kind: 'system-package', manager: 'apt' },
          plan: {
            kind: 'manual',
            explanation: 'Needs sudo.',
            steps: [{ command: 'sudo apt-get update && sudo apt-get install --only-upgrade fy' }],
          },
        }),
      ),
    );
    expect(container.querySelector('[data-about-plan="manual"]')?.textContent).toContain('Needs sudo.');
    expect(container.querySelector('[data-about-plan="manual"]')?.textContent).not.toContain('Switch to');
  });

  it('tells an older machine apart from a failed read', async () => {
    let container = await show(new FakeMachine(new HttpRefusal('unknown route', 404, 'unknown_route')));
    expect(container.querySelector('[data-about-missing]')).not.toBeNull();
    await mounted?.unmount();
    container = await show(new FakeMachine(new Error('the relay is down')));
    expect(container.textContent).toContain('could not read what this machine runs: the relay is down');
    await mounted?.unmount();
    container = await show(new FakeMachine(updateView()));
    expect(container.textContent).toContain('Update available');
  });

  it('says it is reading until the machine answers', async () => {
    mounted = await mount(
      <AboutMachineSurface connection={connection} createClient={() => new Promise(() => undefined)} />,
    );
    expect(mounted.container.textContent).toContain('Reading what this machine runs…');
  });

  it('mounts as a Settings › Machine panel', async () => {
    const tab = aboutSettingsTab(async () => new FakeMachine(updateView()));
    expect(tab.id).toBe('about');
    const Surface = tab.Surface;
    mounted = await mount(<Surface connection={connection} />);
    await settle();
    expect(mounted.container.textContent).toContain('Update available');
  });
});
