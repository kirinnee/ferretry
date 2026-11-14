/**
 * The browser entry for "Settings › This device › Open links in": the REAL panel over this device's controls — no daemon,
 * no network. Everything on screen is fake data.
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { OpenLinksInPanel } from '../../../../app/features/settings/open-links-in-panel.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

createRoot(document.getElementById('root') as HTMLElement).render(
  <main className="fy-page" style={{ boxSizing: 'border-box', margin: '0 auto', maxWidth: 720, padding: 16 }}>
    <h1>This device</h1>
    <OpenLinksInPanel />
  </main>,
);
