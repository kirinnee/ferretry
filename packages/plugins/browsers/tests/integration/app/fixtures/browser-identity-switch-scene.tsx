/**
 * The REAL remote viewer, in a real browser, over ONE display stream that is handed from a page of one identity's Chrome to a
 * page of another's, the way the daemon does it: the status names the new page, then the new page's first frame arrives on the
 * same socket. The test holds that frame's image request, so there is a moment where the frame has ARRIVED and is not painted.
 * Synthetic pages, no network beyond the page's own origin.
 *
 * The page exposes `window.fixture`:
 *   - `sent`: every message the viewer sent on the stream, parsed
 *   - `show(pageId)`: the status now names that page as the active one
 *   - `frame(pageId, name)`: a frame for that page ARRIVES on the stream, its image at `/frames/<name>.svg`
 */

import { createRoot } from 'react-dom/client';
import '../../../../app/features/browser/browser.css';
import {
  RemoteBrowserViewer,
  type RemoteBrowserSocket,
} from '../../../../app/features/browser/remote-browser-viewer.tsx';
import { type BrowserDaemon, browserSessionScope } from '../../../../app/lib/scope.ts';
import type { BrowserStatus } from '../../../../contract/wire/browser.ts';

const daemon: BrowserDaemon = { daemonId: 'daemon-switch', client: {} as BrowserDaemon['client'] };
const scope = browserSessionScope(daemon, 'switch-session');

const pages = [
  {
    id: 'p1',
    name: 'app',
    url: 'https://app.example.invalid/home',
    title: 'Home',
    ownerName: 'Hadi',
    identity: 'agent',
  },
  {
    id: 'work-p1',
    name: 'billing',
    url: 'https://billing.example.invalid/invoices',
    title: 'Invoices',
    ownerName: 'Hadi',
    identity: 'work',
  },
];

const statusOf = (activePageId: string) =>
  ({
    sessionId: 'switch-session',
    state: 'running',
    url: 'https://example.invalid/',
    title: 'Switch',
    pages,
    activePageId,
    canGoBack: false,
    canGoForward: false,
    pageState: 'ready',
    viewport: { width: 400, height: 300 },
    viewers: 1,
    persistentProfile: true,
    idleTimeoutSeconds: 900,
    capacity: { running: 2, maximum: 60 },
  }) as unknown as BrowserStatus;

const listeners = new Map<string, ((event: Event) => void)[]>();
const sent: unknown[] = [];
const names: string[] = [];

/** ONE stream for the whole run: a handoff between identities never opens another. */
const socket: RemoteBrowserSocket = {
  readyState: 1,
  binaryType: 'blob',
  addEventListener: (type, listener) => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  },
  send: data => {
    sent.push(JSON.parse(data));
  },
  close: () => undefined,
};
const socketFactory = (): RemoteBrowserSocket => {
  setTimeout(() => {
    for (const listener of listeners.get('open') ?? []) listener(new Event('open'));
  }, 0);
  return socket;
};

const encodeFrame = (pageId: string): ArrayBuffer => {
  const id = new TextEncoder().encode(pageId);
  const bytes = new Uint8Array(7 + id.length + 2);
  bytes.set([0x46, 0x59, 0x42, 0x46, 1, 0, id.length]);
  bytes.set(id, 7);
  bytes.set([1, 2], 7 + id.length);
  return bytes.buffer;
};

const createObjectUrl = (): string => `/frames/${names.shift() ?? 'a'}.svg`;
const revokeObjectUrl = (): void => undefined;
const root = createRoot(document.getElementById('root') as HTMLElement);
const draw = (activePageId: string): void =>
  root.render(
    <RemoteBrowserViewer
      daemon={daemon}
      scope={scope}
      status={statusOf(activePageId)}
      interactive
      fit={false}
      showHeader={false}
      socketFactory={socketFactory}
      createObjectUrl={createObjectUrl}
      revokeObjectUrl={revokeObjectUrl}
    />,
  );

Object.assign(window, {
  fixture: {
    sent,
    show: (pageId: string) => draw(pageId),
    frame: (pageId: string, name: string) => {
      names.push(name);
      for (const listener of listeners.get('message') ?? [])
        listener(new MessageEvent('message', { data: encodeFrame(pageId) }));
    },
  },
});
draw('p1');
