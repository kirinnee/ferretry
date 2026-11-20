/**
 * The browser entry for "Settings › Catalogs when the list cannot be read": the REAL `CatalogsSurface` over a fake machine
 * that refuses the catalog list until the person presses Try again (a read marked `quiet: false`).
 * `window.__catalogReads` lists each list read: `false` for a person's press, `null` for the page's own read.
 *
 *   ?theme=<family>-<mode>
 */
import { DaemonCallError } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { CatalogsSurface } from '../../../../app/features/catalogs/catalogs-surface.tsx';
import { daemonConnection } from '../../../../app/lib/machine.ts';
import type { CatalogClient } from '../../../../app/lib/catalog-client.ts';
import { ownedCatalog } from '../../../unit/app/support/catalog-views.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const seen = window as unknown as { __catalogReads: (false | null)[] };
seen.__catalogReads = [];

const client = {
  request: async (_path: string, _schema: unknown, init?: { quiet?: false }) => {
    const pressed = init?.quiet === false;
    seen.__catalogReads.push(pressed ? false : null);
    if (!pressed) throw new DaemonCallError(500, 'unreadable', 'This machine did not answer the list of catalogs.');
    return { catalogs: [ownedCatalog()] };
  },
} as unknown as CatalogClient;

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="mx-auto max-w-2xl p-panel">
    <CatalogsSurface connection={daemonConnection({ daemonId: 'alpha' })} createClient={async () => client} />
  </div>,
);
