import { afterEach, describe, expect, it } from 'bun:test';
import {
  SettingsHome,
  type SettingsMachineEntry,
  SettingsSidebar,
} from '../../../../src/features/settings/settings-navigation.tsx';
import { daemonId } from '../../../../src/lib/daemon-connection.ts';
import { type Mounted, mount } from '../../../support/dom.ts';

const alpha = daemonId('daemon-alpha');
const beta = daemonId('daemon-beta');

const MACHINES: readonly SettingsMachineEntry[] = [
  { daemonId: alpha, name: 'Alpha', reach: { kind: 'locked' }, updateAvailable: true },
  { daemonId: beta, name: 'Beta', reach: { kind: 'locked' } },
];

const handlers = { onSection: () => undefined, onMachine: () => undefined, onAddMachine: () => undefined };

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const dotted = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-settings-machine]')]
    .filter(row => row.querySelector('[data-settings-machine-update]') !== null)
    .map(row => row.getAttribute('data-settings-machine') ?? '');

describe('the update dot in the machine list', () => {
  it('marks the machine with an update in the sidebar, and says so in words', async () => {
    mounted = await mount(
      <SettingsSidebar machines={MACHINES} active="machines" activeMachine={alpha} {...handlers} />,
    );
    expect(dotted(mounted.container)).toEqual([String(alpha)]);
    expect(mounted.container.querySelector('[data-settings-machine-update]')?.textContent).toBe(', update available');
  });

  it('marks it on the phone’s Settings home too', async () => {
    mounted = await mount(<SettingsHome machines={MACHINES} {...handlers} />);
    expect(dotted(mounted.container)).toEqual([String(alpha)]);
  });
});
