/**
 * The browser entry for the daemon-less first run's own pages (r10 O5): the REAL route over an empty paired list, no network.
 *
 *   ?view=start | target | install | elsewhere | pair | daemon | local    (which page it opens on)
 *   ?theme=<family>-<mode>
 *
 * `start` is the start screen itself; the others open the journey the app's own links and a hand-off link name.
 */
import type { DaemonlessPorts } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { createOnboardingRoute } from '../../../../app/views/onboarding-views.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const ORIGIN = 'https://ferretry.example.invalid';
const ADDRESS: Readonly<Record<string, string>> = {
  start: `${ORIGIN}/onboarding`,
  target: `${ORIGIN}/onboarding?journey=add-daemon`,
  pair: `${ORIGIN}/onboarding?journey=pair`,
  install: `${ORIGIN}/setup#fy-setup=f1;route=first-time;target=this;doer=self;step=install`,
  elsewhere: `${ORIGIN}/setup#fy-setup=f1;route=first-time;target=other;doer=self;step=elsewhere`,
  daemon: `${ORIGIN}/setup#fy-setup=f1;route=first-time;target=this;doer=self;step=daemon`,
  local: `${ORIGIN}/setup#fy-setup=f1;route=first-time;target=this;doer=self;step=local`,
};
const address = ADDRESS[params.get('view') ?? 'start'] ?? ADDRESS.start ?? '';

const NONE = { daemons: [], selected: null };
const ports = { daemons: { snapshot: () => NONE, subscribe: () => () => undefined } } as unknown as DaemonlessPorts;
const OnboardingRoute = createOnboardingRoute(ports);

const root = document.getElementById('root') as HTMLElement;
createRoot(root).render(
  <OnboardingRoute
    chooseDaemon={async () => undefined}
    location={() => address}
    navigate={() => undefined}
    params={{}}
  />,
);
