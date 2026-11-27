/**
 * Settings › Browser › Identities: the REAL Browser tab over a scripted client — no daemon, no network. Every identity name,
 * address and secret name is synthetic. The daemon lists `agent`, `work` (running, a proxy of its own) and `docs` (starting, with a saved proxy for its next launch); the file also
 * holds `partner`, an identity with a proxy of its own that waits for the owner.
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import type { CallClient } from '../../../../app/lib/clients.ts';
import { BrowserTab } from '../../../../app/features/settings/browser-tab.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

/** Written the way an owner would write them: `partner` is held, so it is in the file and not in the daemon's list. */
const CONFIG_TEXT = `mode: headless
identities:
  work:
    proxy:
      url: http://work-proxy.example.test:8080
      username: \${secret:WORK_PROXY_USER}
      password: \${secret:WORK_PROXY_PASSWORD}
  docs: {}
  partner:
    proxy:
      url: http://partner-proxy.example.test:3128
`;

const IDENTITIES = {
  maxRunning: 4,
  identities: [
    {
      identity: 'agent',
      builtIn: true,
      engine: 'chromium',
      running: false,
      lastUsedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    },
    {
      identity: 'work',
      builtIn: false,
      engine: 'chromium',
      running: true,
      startedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
      proxy: { name: 'work-proxy.example.test:8080', own: true },
      liveProxy: null,
    },
    {
      identity: 'docs',
      builtIn: false,
      engine: 'chromium',
      running: false,
      starting: true,
      proxy: { name: 'next-proxy.example.test:8080', own: true },
    },
  ],
};

const client: CallClient = {
  call: (async (route: string) => {
    if (route === 'GET /v1/config/file')
      return { path: 'browsers.yaml', exists: true, text: CONFIG_TEXT, etag: 'e1', state: 'pending' };
    if (route === 'GET /v1/config/status') return { directory: '/x', files: [], issues: [], pending: [] };
    if (route === 'GET /v1/browser/identities') return IDENTITIES;
    if (route === 'GET /v1/browser/state') return { state: 'running' };
    if (route === 'GET /v1/grants')
      return { capabilities: [{ capability: 'fleet', configure: true, configureRefusal: 'granted' }] };
    if (route === 'GET /v1/secrets') return { health: 'ready', secrets: [] };
    throw new Error(`the picture asks nothing of ${route}`);
  }) as CallClient['call'],
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="flex min-w-0 flex-col gap-5 bg-bg p-panel" data-scene="identities">
    <BrowserTab client={client} />
  </div>,
);
