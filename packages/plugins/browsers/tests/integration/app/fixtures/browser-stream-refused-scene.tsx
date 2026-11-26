/**
 * The browser entry for "the display was refused for want of the passkey" (G18 D-87): the REAL `RemoteBrowserPane` (its hook,
 * its viewer and its chrome) over a fake transport that reports a running browser, and a socket the daemon refuses at once
 * (`grant_step_up_required`, close 1008). Nothing here reads a network; every name and address is fake. The
 * confirmation is carried by the actual stream, counted in `window.__confirmed`; the scene counts the
 * streams it opened in `window.__streams`.
 *
 *   ?theme=<palette>-<mode>
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { createRoot } from 'react-dom/client';
import '../../../../app/features/browser/browser.css';
import { RemoteBrowserPane } from '../../../../app/features/browser/remote-browser-pane.tsx';
import type { RemoteBrowserSocket } from '../../../../app/features/browser/remote-browser-viewer.tsx';
import type { RemoteBrowserTransport } from '../../../../app/hooks/use-remote-browser.ts';
import { type BrowserDaemon, browserSessionScope } from '../../../../app/lib/scope.ts';
import type { BrowserStatus } from '../../../../contract/wire/browser.ts';

declare global {
  interface Window {
    __streams: number;
    __confirmed: number;
  }
}

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
window.__streams = 0;
window.__confirmed = 0;

const daemon: BrowserDaemon = { daemonId: 'daemon-refused', client: {} as PluginClient };
const scope = browserSessionScope(daemon, 'refused-session');

const status = {
  sessionId: 'refused-session',
  state: 'running',
  url: 'https://example.invalid/claims/new',
  title: 'New Claim',
  pages: [{ id: 'p1', url: 'https://example.invalid/claims/new', title: 'New Claim' }],
  activePageId: 'p1',
  canGoBack: false,
  canGoForward: false,
  pageState: 'ready',
  viewport: { width: 591, height: 486 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 900,
  capacity: { running: 1, maximum: 3 },
} as unknown as BrowserStatus;

const transport: RemoteBrowserTransport = {
  readStatus: async () => status,
  runAction: async () => ({ status }),
};

/** A stream the daemon refuses as soon as someone listens. */
class RefusedSocket implements RemoteBrowserSocket {
  readyState = 0;
  binaryType: BinaryType = 'arraybuffer';
  readonly #listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(confirm?: true) {
    window.__streams += 1;
    if (confirm) window.__confirmed += 1;
    setTimeout(() => {
      this.readyState = 3;
      const event = new CloseEvent('close', { code: 1008, reason: 'grant_step_up_required' });
      for (const listener of this.#listeners.get('close') ?? []) listener(event);
    }, 0);
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="mx-auto flex h-full max-w-[1100px] flex-col p-4">
    <RemoteBrowserPane
      daemon={daemon}
      scope={scope}
      transport={transport}
      schedule={() => () => undefined}
      socketFactory={(_daemon, _scope, options) => new RefusedSocket(options?.confirm)}
    />
  </div>,
);
