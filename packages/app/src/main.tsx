/**
 * THE BROWSER ENTRY POINT — wiring only (≤150 lines, §10.3). Every decision is in `src/` behind a port; every browser
 * object is bound here, once: storage, IndexedDB, WebCrypto, the WebSocket, the timer, the clock, the document.
 *
 * Load order: index.html → public/pre-paint.js (theme before first paint) → this file → <App />.
 *
 * NO GLOBAL NETWORK FUNCTION reaches the app: the only way to a daemon is the sealed session over the WebSocket bound
 * below, behind the generated client's hash guard (§9.6). Access supplies the device claims and Connections the
 * carriers (`src/connect/provides.ts`); with neither built, every daemon reads "cannot reach yet", nothing is sent.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { connector, type DirectDial, pairOverCarriers, pairOverDirect } from './connect/connector.ts';
import { directoryFetch } from './connect/directory.ts';
import { setMemberCarriers } from './connect/member.ts';
import { registeredConnect, registeredDaemonless, registeredPasskey } from './connect/provides.ts';
import { DaemonList } from './daemons/daemon-list.ts';
import { generated } from './generated/surfaces.ts';
import { DeviceLayoutStore } from './layout/device-layout.ts';
import { ScrollMemory } from './scroll/scroll-memory.ts';
import { trustedWorkerUrl } from './security/trusted-types.ts';
import { directDial, type SocketLike } from './session/direct-dial.ts';
import { WebCryptoRelayCrypto } from './session/webcrypto.ts';
import { App } from './shell/app.tsx';
import { createBrowserInstallPrompt } from './shell/install-prompt.ts';
import { ShellRuntime } from './shell/runtime.ts';
import type { KeyValueStore } from './storage/records.ts';
import { preloadThemeFonts } from './theme/fonts.ts';
import { ThemePreferenceStore } from './theme/preferences.ts';
import { installPortraitLock } from './ui/lib/orientation-lock.ts';
import { whenBackOnScreen } from './ui/hooks/use-document-visible.ts';
import './styles/index.css';
import './ui/design-system.css';

const host = document.getElementById('root');
if (!host) throw new Error('missing #root — the host document is not this app’s index.html'); // never a silent fallback

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

/** The build-time relay directory origin (`vite.config.ts`), the same value the daemon discovers from. */
declare const __FY_RELAY_DIRECTORY__: string | undefined;
const directory = directoryFetch(typeof __FY_RELAY_DIRECTORY__ === 'string' ? __FY_RELAY_DIRECTORY__ : undefined);

const storage = localStore();
const crypto = new WebCryptoRelayCrypto();
const now = (): number => Date.now();
const openSocket = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;
const after = (delayMs: number, run: () => void): void => void window.setTimeout(run, delayMs);
const direct: DirectDial = target =>
  directDial({ address: target.address, daemonId: target.daemon, openSocket, after });

const daemons = new DaemonList({
  storage,
  now,
  // The device key goes with its pairing (Access keeps it).
  forget: daemon => void registered.claims?.forget(daemon).catch(() => {}),
});

// The session layer's parts and the pairing walk (R582: direct first, then the one discovered rendezvous).
const sessionPorts = {
  crypto,
  subtle: window.crypto.subtle,
  indexedDB: databases(),
  now,
  after,
  daemons,
  pairDirect: pairOverDirect(crypto, direct),
  pair: pairOverCarriers(crypto, direct, after, () => registered.pairing),
};
const registered = registeredConnect(generated.surfaces, {
  ...sessionPorts,
  openSocket,
  ...(directory === undefined ? {} : { directory }),
});
setMemberCarriers(registered.member); // only this composition may install them: the barrel has no setter
const daemonless = registeredDaemonless(generated.surfaces, sessionPorts); // pairing ports only, no daemon client
for (const failure of [...registered.failures, ...daemonless.failures])
  console.warn(`${failure.plugin} could not set up its connect part: ${failure.reason}`);
// The one passkey prompt (Access's): its ceremony rides Access's own guarded client, read from the runtime per call.
const passkey = registeredPasskey(generated.surfaces, {
  clientOf: (daemon, plugin) => runtime.client(daemon, plugin),
  daemons,
  origin: window.location.origin,
  credentials: {
    create: options => navigator.credentials.create(options),
    get: options => navigator.credentials.get(options),
  },
});
for (const failure of passkey.failures)
  console.warn(`${failure.plugin} could not set up its passkey prompt: ${failure.reason}`);

const runtime = new ShellRuntime({
  appVersion: generated.appVersion,
  surfaces: generated.surfaces,
  daemons,
  connect: connector({ crypto, claims: registered.claims, carriers: registered.carriers, direct }),
  passkey: () => passkey.passkey,
  daemonless: { views: daemonless.views, location: () => window.location.href },
  onVisible: whenBackOnScreen(document),
  address: window, // the declared fragments leave the address bar here, before the first render (S3)
});

const themes = new ThemePreferenceStore(storage);
const install = createBrowserInstallPrompt(window); // before React: Chromium fires beforeinstallprompt once, early (S13)
const layouts = new DeviceLayoutStore(storage);
// Another tab changed the theme or this device's layout: take it on without writing it back.
window.addEventListener('storage', () => {
  themes.adopt();
  layouts.adopt();
});
preloadThemeFonts(themes.snapshot().family);
// A phone held sideways gets today's portrait gate (the app is drawn for an upright phone).
installPortraitLock(window, document);
themes.subscribe(() => preloadThemeFonts(themes.snapshot().family));
// The signed-release service worker (docs/pwa-release-signing.md, built by scripts/build-release.ts; absent in `vite
// dev`). Its URL goes through the `fy-worker` Trusted Types policy, which `_headers` requires at every script sink.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register(trustedWorkerUrl('/sw.verified.js'), { scope: '/' }).catch(() => {});
}

createRoot(host).render(
  <StrictMode>
    <App {...{ runtime, themes, layouts, install }} browser={window} scroll={new ScrollMemory(tabStore())} />
  </StrictMode>,
);
