/**
 * The Profiles tab as the shell mounts it: the profiles, and below them the components they are built from.
 *
 * Components used to be a tab of their own; they are a second section here, under "Built from". The two
 * sections share one address — `…/profiles/<name>` is a profile and `…/profiles/<kind>%2F<name>` a
 * component — and each is a page-at-a-time flow, so while one has a page open the other steps aside
 * (kept mounted, so what a person typed is not lost) and returns when it is back on its list.
 */

import { useState } from 'react';
import { ComponentsSurface, ComponentsTab } from '../components/components-tab.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { ProfilesTab } from './profiles-tab.tsx';

export function ProfilesSurface(props: MachineTabProps & { readonly machineNames?: ReadonlyMap<string, string> }) {
  const { machineNames, ...tab } = props;
  const [profilesAtList, setProfilesAtList] = useState(true);
  const [componentsAtList, setComponentsAtList] = useState(true);
  return (
    <div className="flex min-w-0 flex-col gap-8" data-profiles-surface="">
      <div hidden={!componentsAtList} data-profiles-section="profiles">
        <ProfilesTab {...tab} onAtList={setProfilesAtList} />
      </div>
      <div hidden={!profilesAtList} data-profiles-section="components">
        {machineNames === undefined ? (
          <ComponentsSurface {...tab} onAtList={setComponentsAtList} />
        ) : (
          <ComponentsTab {...tab} machineNames={machineNames} onAtList={setComponentsAtList} />
        )}
      </div>
    </div>
  );
}
