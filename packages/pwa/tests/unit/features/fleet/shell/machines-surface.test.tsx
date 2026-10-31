import { describe, expect, it } from 'bun:test';
import type { FleetClientFactory } from '../../../../../src/features/fleet/fleet-client.ts';
import type { ShownReach } from '../../../../../src/features/fleet/shell/machine-reach.ts';
import type { MachineTabId } from '../../../../../src/features/fleet/shell/machine-route.ts';
import {
  type DaemonPanelsRenderer,
  EmptyMachineTab,
  emptyMachineTab,
  MachinesSurface,
  type MachineTabProps,
} from '../../../../../src/features/fleet/shell/machines-surface.tsx';
import type { DaemonConnectionRecord } from '../../../../../src/lib/connections.ts';
import type { DaemonId } from '../../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import { machineClient, machineView, pairing } from './machine-support.ts';

const studio = pairing('studio', 'studio-mac');
const work = pairing('work', 'work-linux');
const fresh = pairing('fresh');

const online = (overrides: Parameters<typeof machineView>[0] = {}): ShownReach => ({
  kind: 'online',
  machine: machineView(overrides),
});

const answering: FleetClientFactory = async () => machineClient(machineView());

interface SurfaceOptions {
  readonly daemonId?: DaemonId;
  readonly connections?: readonly DaemonConnectionRecord[];
  readonly tab?: MachineTabId;
  readonly reach?: ShownReach;
  readonly unknownMachine?: string;
  readonly opened?: string[];
  readonly retried?: string[];
  readonly tabs?: Parameters<typeof MachinesSurface>[0]['tabs'];
  readonly setUp?: string[];
  readonly daemonPanels?: DaemonPanelsRenderer;
  readonly removed?: string[];
}

const surface = (options: SurfaceOptions = {}) => (
  <MachinesSurface
    daemonId={options.daemonId ?? studio.daemonId}
    connections={options.connections ?? [studio, work, fresh]}
    tab={options.tab ?? 'runtimes'}
    reach={options.reach ?? online()}
    onRetry={() => options.retried?.push('retry')}
    {...(options.unknownMachine === undefined ? {} : { unknownMachine: options.unknownMachine })}
    onOpen={(id, tab) => options.opened?.push(`${id}:${tab}`)}
    {...(options.setUp === undefined
      ? {}
      : {
          onSetUp: (id: DaemonId, startAt?: string) =>
            options.setUp?.push(startAt === undefined ? String(id) : `${String(id)}#${startAt}`),
        })}
    createClient={answering}
    {...(options.tabs === undefined ? {} : { tabs: options.tabs })}
    {...(options.daemonPanels === undefined ? {} : { daemonPanels: options.daemonPanels })}
    {...(options.removed === undefined ? {} : { onRemove: (id: DaemonId) => options.removed?.push(String(id)) })}
  />
);

const click = async (container: HTMLElement, selector: string): Promise<void> => {
  const element = must(container.querySelector<HTMLElement>(selector), selector);
  await interact(() => element.click());
};

describe('MachinesSurface', () => {
  it('names the machine in its header with its status, and shows the six tabs with the active one current', async () => {
    const view = await mount(surface({ tab: 'profiles' }));
    const header = must(view.container.querySelector<HTMLElement>('[data-machine-header]'), 'header');
    expect(header.querySelector('h2#settings-machine-heading')?.textContent).toBe('studio-mac');
    const status = must(header.querySelector('[data-machine-status]'), 'status');
    expect(status.getAttribute('data-machine-status')).toBe('online');
    expect(status.querySelector('[data-status-shape]')?.getAttribute('data-status-shape')).toBe('ready');
    expect(status.textContent).toContain('Online · 2 runtimes');

    // No switcher, no list of machines and no Add machine: Settings' own navigation chooses the machine.
    expect(view.container.querySelector('[data-machine-switcher]')).toBeNull();
    expect(view.container.querySelector('[data-machine-choice]')).toBeNull();
    expect(view.container.querySelector('[data-machine-add]')).toBeNull();

    const nav = must(view.container.querySelector('nav[data-underline-tabs]'), 'tab strip');
    expect(nav.getAttribute('aria-label')).toBe('studio-mac views');
    const tabs = Array.from(view.container.querySelectorAll('[data-machine-tab]'));
    expect(tabs.map(tab => tab.textContent)).toEqual([
      'Runtimes',
      'Credentials',
      'Profiles',
      'Components',
      'Browser',
      'Machine',
    ]);
    expect(tabs.map(tab => tab.getAttribute('aria-current'))).toEqual([null, null, 'page', null, null, null]);
    for (const tab of tabs) expect(tab.querySelector('svg')).not.toBeNull();
    expect(view.container.querySelector('[data-machine-tab-panel]')?.getAttribute('data-machine-tab-panel')).toBe(
      'profiles',
    );
    expect(view.container.querySelector('[data-machine-tab-empty]')?.getAttribute('data-machine-tab-empty')).toBe(
      'profiles',
    );
    expect(view.container.querySelector('[data-machine-offline]')).toBeNull();
    expect(view.container.querySelector('[data-machine-unreadable]')).toBeNull();
    await view.unmount();
  });

  it('opens a tab by asking the page for its address', async () => {
    const opened: string[] = [];
    const view = await mount(surface({ opened }));
    await click(view.container, '[data-machine-tab="credentials"]');
    expect(opened).toEqual(['studio:credentials']);
    await view.unmount();
  });

  it('hands a supplied tab surface the machine, its reach, the client, the panels and the first run', async () => {
    const seen: MachineTabProps[] = [];
    const Runtimes = (props: MachineTabProps) => {
      seen.push(props);
      return <p data-runtimes-surface="">{props.machineName}</p>;
    };
    const retried: string[] = [];
    const setUp: string[] = [];
    const daemonPanels: DaemonPanelsRenderer = () => null;
    const view = await mount(surface({ tabs: { runtimes: Runtimes }, retried, setUp, daemonPanels }));
    expect(view.container.querySelector('[data-runtimes-surface]')?.textContent).toBe('studio-mac');
    const last = must(seen.at(-1), 'tab props');
    expect(last.machine).toEqual(machineView());
    expect(last.online).toBe(true);
    expect(last.checking).toBe(false);
    expect(String(last.connection.daemonId)).toBe('studio');
    expect(last.createClient).toBe(answering);
    expect(last.daemonPanels).toBe(daemonPanels);
    last.onRetry();
    expect(retried).toEqual(['retry']);
    must(last.onSetUp, 'onSetUp')();
    expect(setUp).toEqual(['studio']);
    must(last.onSetUp, 'onSetUp')('claude');
    expect(setUp).toEqual(['studio', 'studio#claude']);
    await view.unmount();
  });

  it('hands no panels or first run to a tab when the page offers none, and says checking while it is', async () => {
    const seen: MachineTabProps[] = [];
    const view = await mount(
      surface({
        reach: { kind: 'checking' },
        tabs: {
          runtimes: props => {
            seen.push(props);
            return null;
          },
        },
      }),
    );
    const last = must(seen.at(-1), 'tab props');
    expect(last.checking).toBe(true);
    expect(last.online).toBe(true);
    expect(last.machine).toBeNull();
    expect('daemonPanels' in last).toBe(false);
    expect('onSetUp' in last).toBe(false);
    expect(view.container.querySelector('[data-machine-status]')?.textContent).toContain('Checking');
    await view.unmount();
  });

  it('the empty frame factory renders the honest empty tab', async () => {
    const Settings = emptyMachineTab('machine');
    const view = await mount(surface({ tab: 'machine', tabs: { machine: Settings } }));
    expect(view.container.querySelector('[data-machine-tab-empty="machine"] h3')?.textContent).toBe('Machine');
    expect(view.container.textContent).toContain('Nothing is shown here yet for studio-mac.');
    await view.unmount();
  });

  it('an empty frame for a tab id it does not know falls back to the first tab’s words', async () => {
    const view = await mount(<EmptyMachineTab tab={'nonsense' as MachineTabId} machineName="studio-mac" />);
    expect(view.container.querySelector('h3')?.textContent).toBe('Runtimes');
    await view.unmount();
  });

  it('says a machine is offline, keeps the tabs, and checks again on request', async () => {
    const retried: string[] = [];
    const seen: MachineTabProps[] = [];
    const view = await mount(
      surface({
        reach: { kind: 'offline' },
        retried,
        tabs: {
          runtimes: props => {
            seen.push(props);
            return null;
          },
        },
      }),
    );
    expect(view.container.querySelector('[data-machine-offline]')?.textContent).toContain(
      'studio-mac is asleep or offline',
    );
    expect(view.container.querySelectorAll('[data-machine-tab]')).toHaveLength(6);
    expect(must(seen.at(-1), 'props').online).toBe(false);
    expect(must(seen.at(-1), 'props').machine).toBeNull();
    expect(
      view.container.querySelector('[data-machine-status] [data-status-shape]')?.getAttribute('data-status-shape'),
    ).toBe('needs_sign_in');
    await click(view.container, '[data-machine-retry]');
    expect(retried).toEqual(['retry']);
    await view.unmount();
  });

  it('shows why a reachable machine did not share its setup', async () => {
    const view = await mount(
      surface({
        reach: {
          kind: 'unreadable',
          reason: 'This machine runs an older Ferretry that cannot show its setup here yet.',
        },
      }),
    );
    expect(view.container.querySelector('[data-machine-unreadable]')?.textContent).toBe(
      'This machine runs an older Ferretry that cannot show its setup here yet.',
    );
    expect(view.container.querySelector('[data-machine-status]')?.textContent).toContain('Online · Setup not shown');
    await view.unmount();
  });

  it('shows a machine waiting on an unlock as locked', async () => {
    const view = await mount(surface({ reach: { kind: 'locked' } }));
    const status = must(view.container.querySelector('[data-machine-status]'), 'status');
    expect(status.getAttribute('data-machine-status')).toBe('locked');
    expect(status.textContent).toContain('Locked · Open it to unlock');
    expect(status.querySelector('[data-status-shape]')?.getAttribute('data-status-shape')).toBe('refresh_due');
    await view.unmount();
  });

  it('tells machines that share a name apart in its header', async () => {
    const box = pairing('studio', 'box');
    const twin = pairing('twin', 'box');
    const view = await mount(surface({ connections: [box, twin] }));
    expect(view.container.querySelector('#settings-machine-heading')?.textContent).toBe('box (studio.example.test)');
    await view.unmount();
  });

  it('names an unnamed pairing by its address', async () => {
    const view = await mount(surface({ daemonId: fresh.daemonId }));
    expect(view.container.querySelector('#settings-machine-heading')?.textContent).toBe('https://fresh.example.test');
    await view.unmount();
  });

  it('says when a link named a machine this browser has not paired', async () => {
    const view = await mount(surface({ unknownMachine: 'gone-box' }));
    expect(view.container.querySelector('[data-machine-unknown]')?.textContent).toBe(
      'No paired machine is called gone-box, so this shows studio-mac.',
    );
    await view.unmount();
  });

  it('refuses to show a daemon this browser is not paired with', async () => {
    const view = await mount(surface({ daemonId: 'stranger' as DaemonId }));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      'This machine is not paired with this browser, so its setup cannot be shown.',
    );
    expect(view.container.querySelector('[data-machines-surface]')).toBeNull();
    await view.unmount();
  });
});

describe('MachinesSurface: a machine that is not set up', () => {
  it('never opens its first run by itself, and offers “Finish setting up” above everything else', async () => {
    const setUp: string[] = [];
    const view = await mount(surface({ setUp, reach: online({ setUp: false, runtimeCount: 0 }) }));

    // Nothing is asked for on arrival: the first run is a full screen the reader chooses.
    expect(setUp).toEqual([]);
    const banner = must(view.container.querySelector<HTMLElement>('[data-machine-finish-setup]'), 'banner');
    expect(banner.textContent).toContain('Finish setting up studio-mac');
    expect(view.container.querySelector('[data-machine-status]')?.textContent).toContain('Online · Not set up yet');
    // Above the tabs.
    expect(
      banner.compareDocumentPosition(must(view.container.querySelector('nav[data-underline-tabs]'), 'tabs')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);

    await click(view.container, '[data-machine-finish-setup-open]');
    expect(setUp).toEqual(['studio']);
    await view.unmount();
  });

  it('offers no banner for a machine that is set up, checking, offline, unreadable or locked', async () => {
    const reaches: ShownReach[] = [
      online(),
      { kind: 'checking' },
      { kind: 'offline' },
      { kind: 'unreadable', reason: 'no' },
      { kind: 'locked' },
    ];
    for (const reach of reaches) {
      const view = await mount(surface({ setUp: [], reach }));
      expect(view.container.querySelector('[data-machine-finish-setup]')).toBeNull();
      await view.unmount();
    }
  });

  it('offers no banner when the page has no first run to open', async () => {
    const view = await mount(surface({ reach: online({ setUp: false }) }));
    expect(view.container.querySelector('[data-machine-finish-setup]')).toBeNull();
    expect(view.container.querySelectorAll('[data-machine-tab]')).toHaveLength(6);
    await view.unmount();
  });

  it('calls a pairing a newer one replaced the old pairing, and offers to remove it', async () => {
    // The owner's case: the machine was reset, paired again at the same address, and the old pairing stayed.
    const old = { ...pairing('old-identity', 'studio-mac'), baseUrl: studio.baseUrl, pairedAt: 1 };
    const current = { ...studio, pairedAt: 5 };
    const removed: string[] = [];
    const view = await mount(surface({ daemonId: old.daemonId, connections: [current, old], removed }));
    expect(view.container.querySelector('h2#settings-machine-heading')?.textContent).toBe('studio-mac (old pairing)');
    expect(view.container.textContent).not.toContain('old-identity');
    await click(view.container, '[data-machine-replaced-remove]');
    expect(removed).toEqual(['old-identity']);
    await view.unmount();

    // The live pairing reads as itself, with no suffix and no banner.
    const live = await mount(surface({ daemonId: current.daemonId, connections: [current, old], removed }));
    expect(live.container.querySelector('h2#settings-machine-heading')?.textContent).toBe('studio-mac');
    expect(live.container.querySelector('[data-machine-replaced]')).toBeNull();
    await live.unmount();
  });
});
