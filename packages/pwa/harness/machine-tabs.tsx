/**
 * The Machines tabs the harness mounts: the same surfaces the composition root (`App.tsx`) supplies,
 * one line per tab, each owned by the unit that fills it.
 */

import { ComponentsTab } from '../src/features/fleet/components/components-tab.tsx';
import { CredentialsTab } from '../src/features/fleet/credentials/credentials-tab.tsx';
import { BuildProfileStep } from '../src/features/fleet/profiles/build-profile-step.tsx';
import { BUILD_PROFILE_FLOW_KIND, buildProfileFlowInput } from '../src/features/fleet/profiles/profile-model.ts';
import { ProfilesTab } from '../src/features/fleet/profiles/profiles-tab.tsx';
import { createRuntimesTab } from '../src/features/fleet/runtimes/runtimes-tab.tsx';
import { emptyMachineTab, type MachineTabSurfaces } from '../src/features/fleet/shell/machines-surface.tsx';

const HARNESS_MACHINE_NAMES: ReadonlyMap<string, string> = new Map([['clone-source-daemon', 'Work laptop']]);

export const HARNESS_MACHINE_TABS: MachineTabSurfaces = {
  runtimes: createRuntimesTab({
    profileBuilder: { kind: BUILD_PROFILE_FLOW_KIND, flowInput: buildProfileFlowInput, Step: BuildProfileStep },
  }),
  credentials: CredentialsTab,
  profiles: ProfilesTab,
  // The reader's own labels, as `ComponentsSurface` reads them from the store in the app.
  components: props => <ComponentsTab {...props} machineNames={HARNESS_MACHINE_NAMES} />,
  // main.tsx mounts the Settings tab itself, because it needs the harness's other pairings for Clone.
  settings: emptyMachineTab('settings'),
};
