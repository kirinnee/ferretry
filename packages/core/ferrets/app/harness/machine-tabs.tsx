/**
 * The Machines tabs the harness mounts: the same surfaces the composition root (`App.tsx`) supplies,
 * one line per tab, each owned by the unit that fills it.
 */

import { SignInsSurface } from '../features/fleet/credentials/sign-ins-surface.tsx';
import { AgentsTab } from '../features/fleet/machine/agents-tab.tsx';
import { BrowserTab } from '../src/features/fleet/machine/browser-tab.tsx';
import { ProfilesSurface } from '../features/fleet/profiles/profiles-surface.tsx';
import { RuntimesTab } from '../features/fleet/runtimes/runtimes-tab.tsx';
import { emptyMachineTab, type MachineTabSurfaces } from '../features/fleet/shell/machines-surface.tsx';

const HARNESS_MACHINE_NAMES: ReadonlyMap<string, string> = new Map([['clone-source-daemon', 'Work laptop']]);

export const HARNESS_MACHINE_TABS: MachineTabSurfaces = {
  runtimes: RuntimesTab,
  agents: AgentsTab,
  'sign-ins': SignInsSurface,
  // The reader's own labels, as `ComponentsSurface` reads them from the store in the app.
  profiles: props => <ProfilesSurface {...props} machineNames={HARNESS_MACHINE_NAMES} />,
  browser: BrowserTab,
  // main.tsx mounts the Settings tab itself, because it needs the harness's other pairings for Clone.
  machine: emptyMachineTab('machine'),
};
