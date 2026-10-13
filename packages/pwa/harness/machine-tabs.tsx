/**
 * The Machines tabs the harness mounts: the same surfaces the composition root (`App.tsx`) supplies,
 * one line per tab, each owned by the unit that fills it.
 */

import { CredentialsTab } from '../src/features/fleet/credentials/credentials-tab.tsx';
import { createRuntimesTab } from '../src/features/fleet/runtimes/runtimes-tab.tsx';
import { emptyMachineTab, type MachineTabSurfaces } from '../src/features/fleet/shell/machines-surface.tsx';

export const HARNESS_MACHINE_TABS: MachineTabSurfaces = {
  runtimes: createRuntimesTab(),
  credentials: CredentialsTab,
  profiles: emptyMachineTab('profiles'),
  components: emptyMachineTab('components'),
  settings: emptyMachineTab('settings'),
};
