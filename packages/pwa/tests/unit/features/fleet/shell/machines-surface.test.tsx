import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import type { FleetClientFactory } from '../../../../../src/features/fleet/fleet-configuration-surface.tsx';
import type { MachineTabId } from '../../../../../src/features/fleet/shell/machine-route.ts';
import {
  emptyMachineTab,
  type MachineTabProps,
  MachinesSurface,
} from '../../../../../src/features/fleet/shell/machines-surface.tsx';
import type { DaemonConnectionRecord } from '../../../../../src/lib/connections.ts';
import type { DaemonId } from '../../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import { machineClient, machineView, pairing } from './machine-support.ts';

const studio = pairing('studio', 'studio-mac');
const work = pairing('work', 'work-linux');
const fresh = pairing('fresh');

interface Deferred {
  readonly release: () => void;
  readonly promise: Promise<void>;
}
const gate = (): Deferred => {
  let release = (): void => undefined;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { release, promise };
};

/** Each daemon answers what this map says; a daemon it does not name is offline. */
const factory =
  (
    answers: Readonly<Record<string, ReturnType<typeof machineView> | Error>>,
    asked: string[] = [],
  ): FleetClientFactory =>
  async connection => {
    asked.push(String(connection.daemonId));
    return machineClient(answers[String(connection.daemonId)] ?? new Error('unreachable'));
  };

interface SurfaceOptions {
  readonly daemonId?: DaemonId;
  readonly connections?: readonly DaemonConnectionRecord[];
  readonly tab?: MachineTabId;
  readonly unknownMachine?: string;
  readonly createClient?: FleetClientFactory;
  readonly opened?: string[];
  readonly added?: string[];
  readonly tabs?: Parameters<typeof MachinesSurface>[0]['tabs'];
}

const surface = (options: SurfaceOptions = {}) => (
  <MachinesSurface
    daemonId={options.daemonId ?? studio.daemonId}
    connections={options.connections ?? [studio, work, fresh]}
    tab={options.tab ?? 'runtimes'}
    {...(options.unknownMachine === undefined ? {} : { unknownMachine: options.unknownMachine })}
    onOpen={(id, tab) => options.opened?.push(`${id}:${tab}`)}
    onAddMachine={() => options.added?.push('add')}
    createClient={options.createClient ?? factory({ studio: machineView() })}
    {...(options.tabs === undefined ? {} : { tabs: options.tabs })}
  />
);

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });
};

const click = async (container: HTMLElement, selector: string): Promise<void> => {
  const element = must(container.querySelector<HTMLElement>(selector), selector);
  await interact(() => element.click());
};

describe('MachinesSurface', () => {
  it('names the machine on the switcher, checks it once, and shows the five tabs with the active one current', async () => {
    const asked: string[] = [];
    const createClient = factory({ studio: machineView() }, asked);
    const view = await mount(surface({ createClient, tab: 'profiles' }));
    await settle();
    const switcher = must(view.container.querySelector('[data-machine-switcher]'), 'switcher');
    expect(switcher.getAttribute('aria-label')).toBe('Machine: studio-mac. Switch machine');
    expect(switcher.querySelector('[data-status-shape]')?.getAttribute('data-status-shape')).toBe('ready');
    expect(asked).toEqual(['studio']);
    const tabs = Array.from(view.container.querySelectorAll('[data-machine-tab]'));
    expect(tabs.map(tab => tab.textContent)).toEqual(['Runtimes', 'Credentials', 'Profiles', 'Components', 'Settings']);
    expect(tabs.map(tab => tab.getAttribute('aria-current'))).toEqual([null, null, 'page', null, null]);
    expect(view.container.querySelector('[data-machine-tab-empty]')?.getAttribute('data-machine-tab-empty')).toBe(
      'profiles',
    );
    expect(view.container.querySelector('[data-machine-offline]')).toBeNull();

    // Re-rendering with an equal-but-new connections array is not a reason to ask again.
    await view.render(surface({ createClient, tab: 'profiles', connections: [studio, work, fresh] }));
    await settle();
    expect(asked).toEqual(['studio']);
    await view.unmount();
  });

  it('opens a tab by asking the page for its address', async () => {
    const opened: string[] = [];
    const view = await mount(surface({ opened }));
    await click(view.container, '[data-machine-tab="credentials"]');
    expect(opened).toEqual(['studio:credentials']);
    await view.unmount();
  });

  it('hands a supplied tab surface the machine, its reach and the client', async () => {
    const seen: MachineTabProps[] = [];
    const Runtimes = (props: MachineTabProps) => {
      seen.push(props);
      return <p data-runtimes-surface="">{props.machineName}</p>;
    };
    const asked: string[] = [];
    const view = await mount(
      surface({ tabs: { runtimes: Runtimes }, createClient: factory({ studio: machineView() }, asked) }),
    );
    await settle();
    expect(view.container.querySelector('[data-runtimes-surface]')?.textContent).toBe('studio-mac');
    const last = must(seen.at(-1), 'tab props');
    expect(last.machine).toEqual(machineView());
    expect(last.online).toBe(true);
    expect(last.checking).toBe(false);
    expect(String(last.connection.daemonId)).toBe('studio');
    expect(seen[0]?.checking).toBe(true);
    await interact(() => last.onRetry());
    await settle();
    expect(asked).toEqual(['studio', 'studio']);
    await view.unmount();
  });

  it('the empty frame factory renders the honest empty tab', async () => {
    const Settings = emptyMachineTab('settings');
    const view = await mount(surface({ tab: 'settings', tabs: { settings: Settings } }));
    expect(view.container.querySelector('[data-machine-tab-empty="settings"] h3')?.textContent).toBe('Settings');
    expect(view.container.textContent).toContain('Nothing is shown here yet for studio-mac.');
    await view.unmount();
  });

  it('says a machine is offline, keeps the tabs, and checks again on request', async () => {
    const asked: string[] = [];
    const seen: MachineTabProps[] = [];
    const view = await mount(
      surface({
        createClient: factory({}, asked),
        tabs: {
          runtimes: props => {
            seen.push(props);
            return null;
          },
        },
      }),
    );
    await settle();
    expect(view.container.querySelector('[data-machine-offline]')?.textContent).toContain(
      'studio-mac is asleep or offline',
    );
    expect(must(seen.at(-1), 'props').online).toBe(false);
    expect(must(seen.at(-1), 'props').machine).toBeNull();
    expect(
      view.container.querySelector('[data-machine-switcher] [data-status-shape]')?.getAttribute('data-status-shape'),
    ).toBe('needs_sign_in');
    await click(view.container, '[data-machine-retry]');
    await settle();
    expect(asked).toEqual(['studio', 'studio']);
    await view.unmount();
  });

  it('shows why a reachable machine did not share its setup', async () => {
    const view = await mount(surface({ createClient: factory({ studio: new FyHttpError('gone', 404, undefined) }) }));
    await settle();
    expect(view.container.querySelector('[data-machine-unreadable]')?.textContent).toBe(
      'This machine runs an older Ferretry that cannot show its setup here yet.',
    );
    await view.unmount();
  });

  it('says when a link named a machine this browser has not paired', async () => {
    const view = await mount(surface({ unknownMachine: 'gone-box' }));
    expect(view.container.querySelector('[data-machine-unknown]')?.textContent).toBe(
      'No paired machine is called gone-box, so this shows studio-mac.',
    );
    await view.unmount();
  });

  it('lists every paired machine with its state, switches to another, and offers Add machine', async () => {
    const opened: string[] = [];
    const added: string[] = [];
    const slow = gate();
    const asked: string[] = [];
    const answers = factory(
      { studio: machineView(), work: machineView({ name: 'work-linux', setUp: false, runtimeCount: 0 }) },
      asked,
    );
    const createClient: FleetClientFactory = async connection => {
      if (String(connection.daemonId) === 'work') await slow.promise;
      return await answers(connection);
    };
    const view = await mount(surface({ opened, added, createClient }));
    await settle();
    await click(view.container, '[data-machine-switcher]');
    expect(view.container.querySelector('[data-machine-tabs]')).toBeNull();
    expect(view.container.textContent).toContain('All machines');
    const summary = (id: string) =>
      view.container.querySelector(`[data-machine-choice="${id}"] .text-cell`)?.textContent;
    expect(summary('studio')).toBe('Online · 2 runtimes');
    expect(summary('work')).toBe('Checking');
    slow.release();
    await settle();
    expect(summary('work')).toBe('Online · Not set up yet');
    expect(summary('fresh')).toBe('Offline');
    expect(view.container.querySelector('[data-machine-choice="fresh"] .truncate')?.textContent).toBe(
      'https://fresh.example.test',
    );
    expect(view.container.querySelector('[data-machine-choice="studio"]')?.getAttribute('aria-current')).toBe('true');
    expect(view.container.querySelector('[data-machine-choice="studio"]')?.textContent).toContain('Current');

    // Picking the machine you are on just closes the list.
    await click(view.container, '[data-machine-choice="studio"]');
    expect(opened).toEqual([]);
    expect(view.container.querySelector('[data-machine-tabs]')).not.toBeNull();

    await click(view.container, '[data-machine-switcher]');
    await click(view.container, '[data-machine-choice="work"]');
    expect(opened).toEqual(['work:runtimes']);

    await click(view.container, '[data-machine-switcher]');
    await click(view.container, '[data-machine-add]');
    expect(added).toEqual(['add']);
    const close = must(
      Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === 'Close'),
      'close',
    );
    await interact(() => close.click());
    expect(view.container.querySelector('[data-machines-list]')).toBeNull();
    await view.unmount();
  });

  it('refuses to show a daemon this browser is not paired with', async () => {
    const view = await mount(surface({ daemonId: 'stranger' as DaemonId }));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      'This machine is not paired with this browser, so its setup cannot be shown.',
    );
    await view.unmount();
  });
});
