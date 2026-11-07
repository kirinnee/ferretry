/**
 * The new-ferret screen (`/d/<daemon>/new`): the page, bound to the shell's router. The page itself takes its daemon,
 * its client and its navigation as plain props (`features/new-ferret/new-ferret-page.tsx`), so a test mounts it without a shell.
 *
 * The runtime field is the slot `ferrets.new-ferret-account` (contract/slots.ts): whichever plugin contributes a panel
 * there draws the picker (Runtimes does); with none, the page types the runtime itself.
 */

import { useRouter } from '@ferretry/app';
import type { AppComponent, ScreenProps } from '@ferretry/kernel/manifest';
import { NewFerretPage } from '../features/new-ferret/new-ferret-page.tsx';
import type { LiveFerretsClient } from '../lib/client.ts';

/** The runtime a Launch button named: `?agent=` on this page's address. Absent or blank means no hint. */
export const initialAgentOf = (search: string): string | undefined => {
  const agent = new URLSearchParams(search).get('agent')?.trim();
  return agent === undefined || agent === '' ? undefined : agent;
};

export function createNewFerretScreen(client: LiveFerretsClient): AppComponent<ScreenProps> {
  return function NewFerretScreen() {
    const { route, navigate, back } = useRouter();
    // A per-daemon screen is always routed with its daemon; a route without one has nothing to start a ferret on.
    if (route.kind !== 'screen' || route.daemon === undefined) return null;
    const initialAgent = initialAgentOf(globalThis.location?.search ?? '');
    return (
      <NewFerretPage
        client={client}
        daemon={route.daemon}
        onBack={back}
        onNavigate={path => navigate(path)}
        {...(initialAgent === undefined ? {} : { initialAgent })}
      />
    );
  };
}
