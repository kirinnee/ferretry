import { describe, expect, it } from 'bun:test';
import {
  type SettingsMachineEntry,
  SettingsHome,
  SettingsSidebar,
} from '../../../../src/features/settings/settings-navigation.tsx';
import { type DaemonId, daemonId } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import { machineView } from '../fleet/shell/machine-support.ts';

const alpha = daemonId('daemon-alpha');
const beta = daemonId('daemon-beta');

const MACHINES: readonly SettingsMachineEntry[] = [
  { daemonId: alpha, name: 'Alpha workstation', reach: { kind: 'online', machine: machineView({ runtimeCount: 1 }) } },
  { daemonId: beta, name: 'Beta box', reach: { kind: 'locked' } },
];

interface Recorded {
  readonly sections: string[];
  readonly machines: DaemonId[];
  readonly added: number[];
}

const recorder = (): Recorded => ({ sections: [], machines: [], added: [] });

const handlers = (recorded: Recorded) => ({
  onSection: (id: string) => recorded.sections.push(id),
  onMachine: (id: DaemonId) => recorded.machines.push(id),
  onAddMachine: () => recorded.added.push(1),
});

const button = (container: HTMLElement, selector: string): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>(selector), selector);

describe('SettingsSidebar', () => {
  it('groups the browser’s sections apart from the machines, each under its own title', async () => {
    const view = await mount(
      <SettingsSidebar machines={MACHINES} active="appearance" activeMachine={alpha} {...handlers(recorder())} />,
    );
    try {
      const nav = must(view.container.querySelector<HTMLElement>('nav[data-settings-sidebar]'), 'the sidebar');
      expect(nav.getAttribute('aria-label')).toBe('Settings');
      expect(view.container.querySelector('#settings-group-browser')?.textContent).toBe('This browser');
      expect(view.container.querySelector('#settings-group-machines')?.textContent).toBe('Machines');
      const browserList = must(
        view.container.querySelector('[aria-labelledby="settings-group-browser"]'),
        'the browser list',
      );
      expect([...browserList.querySelectorAll('[data-settings-section-choice]')].map(row => row.textContent)).toEqual([
        'Appearance',
        'Behaviour',
      ]);
      const machineList = must(
        view.container.querySelector('[aria-labelledby="settings-group-machines"]'),
        'the machine list',
      );
      expect(
        [...machineList.querySelectorAll('[data-settings-machine]')].map(row =>
          row.getAttribute('data-settings-machine'),
        ),
      ).toEqual(['daemon-alpha', 'daemon-beta']);
      // Add a machine closes the Machines group, after every machine.
      expect(machineList.lastElementChild?.querySelector('[data-machine-add]')?.textContent).toBe('Add a machine');
    } finally {
      await view.unmount();
    }
  });

  it('marks the open browser section as the page, and no machine while one is open', async () => {
    const view = await mount(
      <SettingsSidebar machines={MACHINES} active="behaviour" activeMachine={alpha} {...handlers(recorder())} />,
    );
    try {
      expect(
        [...view.container.querySelectorAll('[data-settings-section-choice]')].map(row =>
          row.getAttribute('aria-current'),
        ),
      ).toEqual([null, 'page']);
      expect(view.container.querySelector('[data-settings-machine][aria-current]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('marks only the active machine, and only while Machines is the open section', async () => {
    const view = await mount(
      <SettingsSidebar machines={MACHINES} active="machines" activeMachine={beta} {...handlers(recorder())} />,
    );
    try {
      expect(
        [...view.container.querySelectorAll('[data-settings-machine]')].map(row => row.getAttribute('aria-current')),
      ).toEqual([null, 'page']);
      expect(view.container.querySelector('[data-settings-section-choice][aria-current]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('shows each machine’s status mark, its spoken word and its summary line', async () => {
    const view = await mount(
      <SettingsSidebar machines={MACHINES} active="machines" activeMachine={alpha} {...handlers(recorder())} />,
    );
    try {
      const row = (id: string): HTMLElement => button(view.container, `[data-settings-machine="${id}"]`);
      expect(row('daemon-alpha').querySelector('[data-status-shape]')?.getAttribute('data-status-shape')).toBe('ready');
      expect(row('daemon-alpha').querySelector('.sr-only')?.textContent).toBe('Online');
      expect(row('daemon-alpha').querySelector('.kt-navpill__sub')?.textContent).toBe('Online · 1 runtime');
      expect(row('daemon-beta').querySelector('[data-status-shape]')?.getAttribute('data-status-shape')).toBe(
        'refresh_due',
      );
      expect(row('daemon-beta').querySelector('.sr-only')?.textContent).toBe('Locked');
      expect(row('daemon-beta').querySelector('.kt-navpill__sub')?.textContent).toBe('Locked · Open it to unlock');
    } finally {
      await view.unmount();
    }
  });

  it('hands every choice to the page, which turns it into an address', async () => {
    const recorded = recorder();
    const view = await mount(
      <SettingsSidebar machines={MACHINES} active="appearance" activeMachine={alpha} {...handlers(recorded)} />,
    );
    try {
      await interact(() => button(view.container, '[data-settings-section-choice="behaviour"]').click());
      await interact(() => button(view.container, '[data-settings-machine="daemon-beta"]').click());
      await interact(() => button(view.container, '[data-machine-add]').click());
      expect(recorded).toEqual({ sections: ['behaviour'], machines: [beta], added: [1] });
    } finally {
      await view.unmount();
    }
  });
});

describe('SettingsHome', () => {
  it('shows the phone’s own sections and every machine as grouped cards', async () => {
    const view = await mount(<SettingsHome machines={MACHINES} {...handlers(recorder())} />);
    try {
      const nav = must(view.container.querySelector<HTMLElement>('nav[data-settings-home]'), 'the home');
      expect(nav.getAttribute('aria-label')).toBe('Settings');
      expect(view.container.querySelector('#settings-home-browser')?.textContent).toBe('This phone');
      expect(view.container.querySelector('#settings-home-machines')?.textContent).toBe('Machines · 2');
      expect(view.container.textContent).toContain('Only this phone. Your machines aren’t affected.');
      expect(
        [...view.container.querySelectorAll('[data-settings-section-choice]')].map(row => row.textContent),
      ).toEqual(['Appearance', 'Behaviour']);
      const alphaRow = button(view.container, '[data-settings-machine="daemon-alpha"]');
      expect(alphaRow.textContent).toContain('Alpha workstation');
      expect(alphaRow.textContent).toContain('Online · 1 runtime');
      expect(alphaRow.querySelector('[data-status-shape]')?.getAttribute('data-status-shape')).toBe('ready');
      expect(button(view.container, '[data-settings-machine="daemon-beta"]').textContent).toContain(
        'Locked · Open it to unlock',
      );
      // A card row never claims to be the current page: the home is the only thing on screen.
      expect(view.container.querySelector('[aria-current]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('draws no empty machine card when nothing is paired, and still offers Add a machine', async () => {
    const recorded = recorder();
    const view = await mount(<SettingsHome machines={[]} {...handlers(recorded)} />);
    try {
      expect(view.container.querySelector('#settings-home-machines')?.textContent).toBe('Machines · 0');
      const machines = must(
        view.container.querySelector('section[aria-labelledby="settings-home-machines"]'),
        'the machines group',
      );
      expect(machines.querySelector('ul')).toBeNull();
      expect(view.container.querySelector('[data-settings-machine]')).toBeNull();
      await interact(() => button(view.container, '[data-machine-add]').click());
      expect(recorded.added).toEqual([1]);
    } finally {
      await view.unmount();
    }
  });

  it('opens a section or a machine on its own screen through the page', async () => {
    const recorded = recorder();
    const view = await mount(<SettingsHome machines={MACHINES} {...handlers(recorded)} />);
    try {
      await interact(() => button(view.container, '[data-settings-section-choice="appearance"]').click());
      await interact(() => button(view.container, '[data-settings-machine="daemon-alpha"]').click());
      await interact(() => button(view.container, '[data-machine-add]').click());
      expect(recorded).toEqual({ sections: ['appearance'], machines: [alpha], added: [1] });
    } finally {
      await view.unmount();
    }
  });
});
