/**
 * THE BROWSER ENTRY POINT — wiring only (≤150 lines, §10.3). Every decision is in `src/` behind a port; every browser
 * object is bound here, once: storage, the WebSocket constructor, the timer, the clock, the document.
 *
 * Load order: index.html → public/pre-paint.js (theme before first paint) → this file → <App />.
 *
 * NO GLOBAL NETWORK FUNCTION reaches the app: the only way to a daemon is the sealed session over the WebSocket bound
 * below, behind the generated client's hash guard (§9.6).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { DaemonTransport } from './client/transport.ts';
import { DaemonList } from './daemons/daemon-list.ts';
import { generated } from './generated/surfaces.ts';
import { directDial, type SocketLike } from './session/direct-dial.ts';
import { noDeviceClaims } from './session/device-claims.ts';
import { SessionTransport } from './session/session-transport.ts';
import { WebCryptoRelayCrypto } from './session/webcrypto.ts';
import { App } from './shell/app.tsx';
import { ShellRuntime } from './shell/runtime.ts';
import type { KeyValueStore } from './storage/records.ts';
import { ThemePreferenceStore } from './theme/preferences.ts';
import './styles/index.css';

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

const storage = localStore();
const crypto = new WebCryptoRelayCrypto();
const claims = noDeviceClaims;

const daemons = new DaemonList({
  storage,
  now: () => Date.now(),
  // The device key goes with its pairing. GAP: Access owns the key store; nothing to forget until it is wired.
  forget: () => {},
});

async function connect(daemon: Parameters<typeof claims.claim>[0]): Promise<DaemonTransport | undefined> {
  const device = await claims.claim(daemon);
  if (device === undefined) return undefined;
  return new SessionTransport({
    crypto,
    daemonId: daemon.daemon,
    device,
    dial: directDial({
      address: daemon.address,
      daemonId: daemon.daemon,
      openSocket: url => new WebSocket(url) as unknown as SocketLike,
      after: (delayMs, run) => void window.setTimeout(run, delayMs),
    }),
  });
}

const runtime = new ShellRuntime({
  appVersion: generated.appVersion,
  surfaces: generated.surfaces,
  daemons,
  connect,
});

const themes = new ThemePreferenceStore(storage);
// Another tab changed the theme: take it on without writing it back.
window.addEventListener('storage', () => themes.adopt());

// The signed-release service worker (docs/pwa-release-signing.md), built to /sw.verified.js by
// scripts/build-release.ts. Absent in `vite dev`, where there is no signed release to check.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.verified.js', { scope: '/' }).catch(() => {});
}

createRoot(host).render(
  <StrictMode>
    <App runtime={runtime} themes={themes} storage={storage} browser={window} />
  </StrictMode>,
);
