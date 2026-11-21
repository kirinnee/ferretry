/**
 * The browser entry for "one task-like title per ferret, no callsign line": the REAL `FerretListBody`, the REAL header
 * `FerretName` and `ActionsPanel` (Rename…). The ferrets come over HTTP from the REAL `FerretsService` the test runs in
 * its own process (`ferret-titles-daemon.ts`), so what the page shows is what the service answers. Everything on screen
 * is fake data.
 *
 *   ?view=list (default)   the list, the way the side column draws it
 *   ?view=header&ferret=f-ora   the chat header: the title alone, and its Actions menu
 *   ?view=live&ferret=f-ora   the header above the list
 *   ?theme=<family>-<mode>
 */

import { RouterProvider } from '@ferretry/app/testing/router';
import { createRoot } from 'react-dom/client';
import { deviceControls } from '@ferretry/app';
import { FerretsChanged } from '../../../../contract/index.ts';
import { ActionsPanel } from '../../../../app/features/header/actions-panel.tsx';
import { FerretName } from '../../../../app/features/header/name-panel.tsx';
import { FerretListBody } from '../../../../app/features/list/ferret-list.tsx';
import type { LiveFerretsClient } from '../../../../app/lib/client.ts';
import { useFerret } from '../../../../app/lib/ferret-read.ts';
import '../../../../app/features/header/ferret-actions.css';
import '../../../../app/features/list/ferret-list.css';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
deviceControls().setDeviceControls({ sessionsMode: 'all' });

type Change = { readonly ferret: string; readonly gone?: boolean };
type Init = { readonly params?: { readonly ferretId?: string }; readonly body?: unknown };

const answer = async (path: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(path, init);
  const body = (await response.json()) as { message?: string };
  if (!response.ok) throw new Error(body.message ?? `${response.status}`);
  return body;
};

/** The routes the screens call, answered by the service behind the test's server; `ferrets.changed` is polled. */
const client: LiveFerretsClient = {
  call: (async (route: string, init?: Init) => {
    const ferret = encodeURIComponent(init?.params?.ferretId ?? '');
    if (route === 'GET /v1/ferrets') return await answer('/v1/ferrets');
    if (route === 'GET /v1/ferrets/:ferretId') return await answer(`/v1/ferrets/${ferret}`);
    if (route === 'POST /v1/ferrets/:ferretId/rename')
      return await answer(`/v1/ferrets/${ferret}/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(init?.body ?? {}),
      });
    throw new Error(`the scene does not answer ${route}`);
  }) as never,
  subscribe: ((event: unknown, handler: (change: Change) => void) => {
    if (event !== FerretsChanged) return () => undefined;
    let seen = 0;
    let busy = false;
    const timer = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const fresh = (await answer(`/__changes?after=${seen}`)) as Change[];
        seen += fresh.length;
        for (const change of fresh) handler(change);
      } catch {
        // the next tick tries again
      } finally {
        busy = false;
      }
    }, 100);
    return () => window.clearInterval(timer);
  }) as never,
};

const screens = [{ plugin: 'ferrets', id: 'ferrets', path: 'ferrets', label: 'Ferrets' }];
// The route the list reads, with the query kept: a reload of this address draws the same scene.
window.history.pushState(null, '', `/d/alpha/ferrets${window.location.search}`);

const named = params.get('ferret') ?? 'f-zoe';

function Header() {
  const { read } = useFerret(client, named);
  if (read.kind !== 'ready') return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
      <FerretName compact={false} ferret={read.ferret} />
      <ActionsPanel client={client} subject={named} />
    </div>
  );
}

const view = params.get('view') ?? 'list';
createRoot(document.getElementById('root') as HTMLElement).render(
  <RouterProvider screens={screens}>
    <div style={{ boxSizing: 'border-box', margin: '0 auto', maxWidth: view === 'header' ? 720 : 420, padding: 8 }}>
      {view === 'list' ? null : <Header />}
      {view === 'header' ? null : <FerretListBody client={client} needing={new Map()} />}
    </div>
  </RouterProvider>,
);
