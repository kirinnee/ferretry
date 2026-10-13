/**
 * The Machines tabs the harness mounts: the same surfaces the composition root (`App.tsx`) supplies,
 * one line per tab, each owned by the unit that fills it.
 */

import { ComponentsTab } from '../src/features/fleet/components/components-tab.tsx';
import { ProfilesTab } from '../src/features/fleet/profiles/profiles-tab.tsx';
import { emptyMachineTab, type MachineTabSurfaces } from '../src/features/fleet/shell/machines-surface.tsx';

export const HARNESS_MACHINE_TABS: MachineTabSurfaces = {
  runtimes: emptyMachineTab('runtimes'),
  credentials: emptyMachineTab('credentials'),
  profiles: ProfilesTab,
  components: ComponentsTab,
  // main.tsx mounts the Settings tab itself, because it needs the harness's other pairings for Clone.
  settings: emptyMachineTab('settings'),
};
