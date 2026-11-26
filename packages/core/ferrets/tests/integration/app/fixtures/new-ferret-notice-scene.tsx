/**
 * Browser entry for E-266 on the FERRETS side: the REAL `NewFerretPage` over a daemon that answers a start with the
 * "Started without Fast" notice. Every call lands on `window.__calls`, every navigation on `window.__navigated`. No
 * network.
 *
 *   ?theme=<palette>-<mode>
 */
import { createRoot } from 'react-dom/client';
import type { FerretsClient } from '../../../../app/lib/client.ts';
import { NewFerretPage } from '../../../../app/features/new-ferret/new-ferret-page.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOTICE = 'Started without Fast: Codex’s model list is still loading; try again in a few seconds';
const win = window as unknown as { __calls: string[]; __navigated: string[] };
win.__calls = [];
win.__navigated = [];

const client: FerretsClient = {
  call: async <Answer,>(route: string): Promise<Answer> => {
    win.__calls.push(route);
    if (route === 'GET /v1/ferrets') return [] as Answer;
    if (route === 'POST /v1/ferrets') return { id: 'new-ferret', notice: NOTICE } as Answer;
    throw new Error(`no route ${route}`);
  },
} as FerretsClient;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="">
      <NewFerretPage
        AccountSlot={({ fallback }) => fallback}
        client={client}
        daemon="fake"
        onNavigate={path => win.__navigated.push(path)}
      />
    </div>,
  );
