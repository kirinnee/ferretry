/**
 * The Sign-ins tab: every way a ferret signs in, together — the AI logins the runtimes use, and below them
 * the sites an agent signs in to, the secrets it may use, and values moved without it seeing them.
 *
 * The logins are `credentials-tab.tsx`; the rest are the daemon's own panels, asked of the panel frame as a
 * group (`machine-panels.ts`). A login's page, or an open panel, is a page of its own and takes the tab.
 */

import { useState } from 'react';
import { useSettingsFlow } from '../setup/settings-route.ts';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { CredentialsTab } from './credentials-tab.tsx';

export function SignInsSurface(props: MachineTabProps & { readonly browser?: Window }) {
  const { machineName, daemonPanels, browser } = props;
  const route = useSettingsFlow(machineName, browser, 'sign-ins');
  const [loginsAtList, setLoginsAtList] = useState(true);

  if (route.panel !== null && daemonPanels !== undefined) return daemonPanels(route.panel, route.openPanel);

  return (
    <div className="flex min-w-0 flex-col gap-6" data-sign-ins-surface="">
      <CredentialsTab {...props} onAtList={setLoginsAtList} />
      {loginsAtList ? daemonPanels?.(undefined, route.openPanel, 'site-sign-ins') : null}
    </div>
  );
}
