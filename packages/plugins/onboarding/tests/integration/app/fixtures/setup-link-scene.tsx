/**
 * The browser entry for `/setup`: the REAL first-run page, opened the way the OTHER device opens a hand-off link
 * (`/setup#fy-setup=…`), over an empty paired list. No network. The link names a place (add a device, the pairing step), and the
 * page is on that step rather than at the beginning.
 *
 *   ?theme=<family>-<mode>
 */
import type { DaemonlessPorts } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { createOnboardingRoute } from '../../../../app/views/onboarding-views.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NONE = { daemons: [], selected: null };
const ports = { daemons: { snapshot: () => NONE, subscribe: () => () => undefined } } as unknown as DaemonlessPorts;
const OnboardingRoute = createOnboardingRoute(ports);

const root = document.getElementById('root') as HTMLElement;
createRoot(root).render(
  <OnboardingRoute
    chooseDaemon={async () => undefined}
    location={() => 'https://ferretry.example.invalid/setup#fy-setup=f1;route=add-client;step=scan'}
    navigate={() => undefined}
    params={{}}
  />,
);
