/**
 * THE BROWSER ENTRY POINT — wiring only (≤150 lines, §10.3). Every decision is in `src/` behind a port; every browser
 * object is bound here, once: storage, IndexedDB, WebCrypto, the WebSocket constructor, the timer, the clock, the
 * document.
 *
 * Load order: index.html → public/pre-paint.js (theme before first paint) → this file → <App />.
 *
 * NO GLOBAL NETWORK FUNCTION reaches the app: the only way to a daemon is the sealed session over the WebSocket bound
 * below, behind the generated client's hash guard (§9.6). Access's app half supplies the device claims and
 * Connections' the carriers (`src/connect/provides.ts`), both read from the generated surfaces registry; with neither
 * built, every daemon reads "cannot reach yet" and nothing is sent.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { connector, type DirectDial, pairOverDirect } from './connect/connector.ts';
import { registeredConnect } from './connect/provides.ts';
import { DaemonList } from './daemons/daemon-list.ts';
import { generated } from './generated/surfaces.ts';
import { DeviceLayoutStore } from './layout/device-layout.ts';
import { ScrollMemory } from './scroll/scroll-memory.ts';
import { trustedWorkerUrl } from './security/trusted-types.ts';
import { directDial, type SocketLike } from './session/direct-dial.ts';
import { WebCryptoRelayCrypto } from './session/webcrypto.ts';
import { App } from './shell/app.tsx';
import { ShellRuntime } from './shell/runtime.ts';
import type { KeyValueStore } from './storage/records.ts';
import { preloadThemeFonts } from './theme/fonts.ts';
import { ThemePreferenceStore } from './theme/preferences.ts';
import './styles/index.css';
import './ui/design-system.css';

const host = document.getElementById('root');
// A document without `#root` is not this app's document; a silent fallback would hide what is serving the HTML.
if (!host) throw new Error('missing #root — the host document is not this app’s index.html');

/** This origin's localStorage, or `null` where the browser refuses it (a private window, a sandbox). */
function localStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** This tab's sessionStorage (the router trail and scroll memory), or `null` where refused. */
function tabStore(): KeyValueStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** IndexedDB, or `null` where refused. Only the plugins that keep keys open it (`fy-<id>`, §9.4). */
function databases(): IDBFactory | null {
  try {
    return window.indexedDB ?? null;
  } catch {
    return null;
  }
}

const storage = localStore();
const crypto = new WebCryptoRelayCrypto();
const now = (): number => Date.now();
const openSocket = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;
const after = (delayMs: number, run: () => void): void => void window.setTimeout(run, delayMs);
const direct: DirectDial = target => directDial({ address: target.address, daemonId: target.daemon, openSocket, after });

const daemons = new DaemonList({
  storage,
  now,
  // The device key goes with its pairing (Access keeps it).
  forget: daemon => void registered.claims?.forget(daemon).catch(() => {}),
});

const registered = registeredConnect(generated.surfaces, {
  crypto,
  subtle: window.crypto.subtle,
  indexedDB: databases(),
  openSocket,
  after,
  now,
  daemons,
  pairDirect: pairOverDirect(crypto, direct),
});
for (const failure of registered.failures) console.warn(`${failure.plugin} could not set up its connect part: ${failure.reason}`);

const runtime = new ShellRuntime({
  appVersion: generated.appVersion,
  surfaces: generated.surfaces,
  daemons,
  connect: connector({ crypto, claims: registered.claims, carriers: registered.carriers, direct }),
});

const themes = new ThemePreferenceStore(storage);
const layouts = new DeviceLayoutStore(storage);
// Another tab changed the theme or this device's layout: take it on without writing it back.
window.addEventListener('storage', () => {
  themes.adopt();
  layouts.adopt();
});
preloadThemeFonts(themes.snapshot().family);
themes.subscribe(() => preloadThemeFonts(themes.snapshot().family));

// The signed-release service worker (docs/pwa-release-signing.md), built to /sw.verified.js by
// scripts/build-release.ts. Absent in `vite dev`, where there is no signed release to check. Its URL goes through the
// `fy-worker` Trusted Types policy: `_headers` requires one at every script sink, a registration included.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register(trustedWorkerUrl('/sw.verified.js'), { scope: '/' }).catch(() => {});
}

createRoot(host).render(
  <StrictMode>
    <App
      runtime={runtime}
      themes={themes}
      layouts={layouts}
      browser={window}
      scroll={new ScrollMemory(tabStore())}
    />
  </StrictMode>,
);
