/**
 * The browser entry for the Grants card under a chosen style and palette (`?style=&palette=&mode=`, default neo / neo / light):
 * the REAL `GrantsCard` over fake grants, no daemon. It is the row-shaped switch whose title is accent text when on, which Neo's
 * first polish painted accent-on-accent and squeezed to 14px (r10 T13 fix); `grants-neo.visual.test.ts` holds its text to 4.5:1.
 */
import { createRoot } from 'react-dom/client';
import type { GrantsView } from '../../../../contract/index.ts';
import { GrantsCard } from '../../../../app/features/settings/grants-settings.tsx';
import { daemonConnection } from '../../../../app/shell-grants.ts';

const params = new URLSearchParams(window.location.search);
const root = document.documentElement;
root.dataset.style = params.get('style') ?? 'neo';
root.dataset.palette = params.get('palette') ?? 'neo';
root.dataset.mode = params.get('mode') ?? 'light';

const CAPABILITIES = ['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing', 'secrets'] as const;
const connection = daemonConnection({ daemonId: 'grants', baseUrl: 'https://grants.example.test', deviceId: 'token' });

/** Every capability's use is on; configure alternates, so the page holds checked and unchecked switches. */
const view: GrantsView = {
  capabilities: CAPABILITIES.map((capability, index) => ({
    capability,
    use: true,
    configure: index % 2 === 0,
    granted: { use: true, configure: index % 2 === 0 },
    useRefusal: 'granted' as const,
    configureRefusal: 'granted' as const,
    origin: 'default' as const,
    mayGrant: false,
  })),
  governed: true,
  hostLocal: false,
  steppedUp: true,
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <main className="bg-bg text-fg" data-scene="" style={{ minHeight: '100vh', padding: 16, maxWidth: 720 }}>
    <GrantsCard connection={connection} onChange={() => undefined} view={view} />
  </main>,
);
