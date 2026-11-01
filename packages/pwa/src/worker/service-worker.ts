/**
 * THE SERVICE WORKER — the composition root of the signed-release check, built to `/sw.verified.js`
 * by `scripts/build-release.ts`.
 *
 * Wiring only, like `main.tsx`: every decision is in `lib/release-keeper.ts` and
 * `lib/release-verification.ts`, and every browser object is bound here, once, to the ports those
 * modules take. It is outside both coverage ledgers for the same reason `bin/` is — it runs only
 * inside a browser's worker — and `tests/integration/release-worker.test.ts` drives the built file in
 * a real Chromium instead.
 *
 * What it does, in order:
 *   - install: download, verify and cache the release the site serves now;
 *   - activate: take control of the pages that are open, so the first install protects them now;
 *   - fetch: re-check the site on every page load; once a verified release exists, answer EVERY
 *     same-origin page load from it and every subresource it lists, from bytes re-hashed on the
 *     way out, with the headers `_headers` names;
 *     leave everything else — every daemon request included — exactly as the page sent it;
 *   - message: answer the page's "check now", "what happened" and "is this new worker signed?";
 *   - push / notificationclick: show a daemon's Web Push notification and open what it names, after
 *     applying this device's own notification filter (`lib/notification-filter.ts`) — see the `push`
 *     listener's own comment for what is shown when the filter says hide it.
 *
 * ONE FILE, TWO KINDS OF REGISTRATION. The app registers this worker at `/`, and once per machine at
 * `/push/<daemonId>/` for that machine's own push subscription (`lib/push-scope.ts`). Every copy runs
 * the same release check over the same storage, so no page escapes it whichever copy controls it. A
 * per-machine copy knows its machine from its own registration scope — which the page chose, never a
 * push — and shows only that machine's notifications: titled with the reader's label for it, tagged in
 * its namespace, and opening only its pages. A push that still reaches the app-wide copy — the old shared
 * subscription, before the app drops it at start — is titled "Unverified" and opens only the app. The
 * notifications the open PAGE shows through the app-wide registration are its own, and keep their links.
 *
 * Three values are compiled in by the build and nothing else: the release public key from
 * `packages/pwa/release-signing-key.pub`, the app's rewrites from `public/_redirects`, and its
 * header rules from `public/_headers`. The key is the ONE anchor: nothing this worker stores is
 * trusted, because any page on this origin can write IndexedDB and Cache Storage.
 */

import { isLoopbackHost, PushNotificationPayloadSchema } from '@ferretry/protocol';
import { shouldShowNotification } from '../lib/notification-filter.ts';
import { readMirroredNotificationFilter } from '../lib/notification-filter-mirror.ts';
import { notificationWindow, openInWindow } from '../lib/notification-open.ts';
import { notificationBrand, showGroupedNotification } from '../lib/notify.ts';
import {
  filteredPushNotification,
  machineNotification,
  notificationTapUrl,
  notificationUrl,
  pushMachineOf,
  unreadablePushTitle,
  unverifiedNotification,
} from '../lib/push-scope.ts';
import type { ReleaseHeaderRule } from '../lib/release-headers.ts';
import { answerReleaseRequest, parseReleaseRequest, ReleaseKeeper } from '../lib/release-keeper.ts';
import type { ReleaseRewrite } from '../lib/release-manifest.ts';
import { CacheStorageReleaseCaches, FetchReleaseNetwork, IndexedDbReleaseState } from '../lib/release-storage.ts';

declare const __FY_RELEASE_KEY__: string;
declare const __FY_RELEASE_REWRITES__: readonly ReleaseRewrite[];
declare const __FY_RELEASE_HEADERS__: readonly ReleaseHeaderRule[];

/** The worker-global surface this file uses, typed here rather than through the WebWorker lib. */
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
interface MessageEvent extends ExtendableEvent {
  readonly data: unknown;
  readonly ports: readonly MessagePort[];
}
interface PushEvent extends ExtendableEvent {
  readonly data: { json(): unknown } | null;
}
interface NotificationEvent extends ExtendableEvent {
  readonly notification: { readonly data?: unknown; close(): void };
}
interface WindowClientLike {
  readonly url: string;
  readonly focused: boolean;
  readonly visibilityState: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
  postMessage(message: unknown, transfer: Transferable[]): void;
}
interface WorkerScope {
  readonly location: { readonly origin: string; readonly hostname: string; readonly href: string };
  readonly registration: Parameters<typeof showGroupedNotification>[0] & { readonly scope: string };
  readonly clients: {
    claim(): Promise<void>;
    matchAll(options: { type: 'window'; includeUncontrolled?: boolean }): Promise<readonly WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: NotificationEvent) => void): void;
}

const worker = globalThis as unknown as WorkerScope;
const origin = worker.location.origin;
/** The machine this copy serves, or `null` for the app-wide registration. Fixed for the worker's life. */
const machine = pushMachineOf(worker.registration.scope, worker.location.href);

const network = new FetchReleaseNetwork((input, init) => globalThis.fetch(input, init), origin);
const keeper = new ReleaseKeeper({
  network,
  caches: new CacheStorageReleaseCaches(globalThis.caches),
  state: new IndexedDbReleaseState(globalThis.indexedDB),
  compiledKey: __FY_RELEASE_KEY__,
  // An unsigned build runs unrefused only on a developer's own machine. Decided from the page's
  // hostname, which a deploy cannot change, so a production origin can never accept one.
  allowUnsigned: isLoopbackHost(worker.location.hostname),
  rewrites: __FY_RELEASE_REWRITES__,
  headers: __FY_RELEASE_HEADERS__,
});

worker.addEventListener('install', event => {
  // An install never FAILS on a refused release: a worker that failed to install could not raise
  // the alarm about the next one, and the network still serves the page exactly as it would have.
  event.waitUntil(keeper.update().catch(() => undefined));
});

worker.addEventListener('activate', event => {
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Not this site: a daemon, a relay, anything else. Never touched.
  if (url.origin !== origin) return;
  const navigate = request.mode === 'navigate';
  // Every page load also re-checks the site (two small files; one check at a time). That is what
  // keeps a release a page put back from outliving one load after the worker starts: the check
  // re-confirms the newer release and raises the worker's floor above the restored one.
  if (navigate) event.waitUntil(keeper.update().catch(() => undefined));
  event.respondWith(
    keeper
      .respond({ pathname: url.pathname, navigate })
      .catch(() => null)
      .then(answer =>
        answer === null
          ? globalThis.fetch(request)
          : new Response(answer.bytes as Uint8Array<ArrayBuffer>, {
              status: answer.status,
              headers: [...answer.headers] as [string, string][],
            }),
      ),
  );
});

worker.addEventListener('message', event => {
  const { data } = event;
  // The update chip's request (`hooks/use-service-worker-update.ts`).
  if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'SKIP_WAITING') {
    event.waitUntil(worker.skipWaiting());
    return;
  }
  const request = parseReleaseRequest(data);
  const port = event.ports[0];
  if (request === null || port === undefined) return;
  event.waitUntil(
    answerReleaseRequest(keeper, request, origin, network).then(
      reply => port.postMessage(reply),
      () => port.postMessage(null),
    ),
  );
});

worker.addEventListener('push', event => {
  let payload: unknown = null;
  try {
    payload = event.data?.json() ?? null;
  } catch {
    payload = null;
  }
  const parsed = PushNotificationPayloadSchema.safeParse(payload);
  event.waitUntil(
    (async () => {
      if (!parsed.success) {
        // A push the daemon did not compose is still shown, plainly: a subscription that receives a
        // push and shows nothing is penalised by the browser and eventually revoked. There is no
        // `kind` to filter on — this branch never reaches the decision below at all.
        await worker.registration.showNotification(unreadablePushTitle(machine), {
          ...notificationBrand(),
          body: 'Something is waiting in your Inbox.',
        });
        return;
      }
      // Every daemon sends every event now (no server-side filter left to consult — see
      // `packages/daemon/src/lib/push/service.ts`); this device's own filter is the only thing left
      // that decides. The mirror (`notification-filter-mirror.ts`) is what makes that possible here:
      // a service worker cannot read `localStorage`, which is where the live, authoritative answer
      // actually lives.
      const kind = 'kind' in parsed.data && parsed.data.kind !== undefined ? parsed.data.kind : null;
      const filter = await readMirroredNotificationFilter(globalThis.indexedDB);
      const visible = shouldShowNotification({ kind, daemonId: machine?.daemonId ?? null }, filter, new Date());
      if (!visible) {
        // THE LEAST-BAD COMPLIANT ANSWER (see `filteredPushNotification`'s own doc): a push that
        // shows nothing risks the browser revoking the subscription, so something is shown — quiet,
        // never the suppressed content, and collapsed with every other filtered push for this
        // machine under one fixed tag rather than piling up.
        const quiet = filteredPushNotification(machine, origin);
        await worker.registration.showNotification(quiet.title, quiet.options);
        return;
      }
      await showGroupedNotification(
        worker.registration,
        machine === null
          ? unverifiedNotification(parsed.data, origin)
          : machineNotification(parsed.data, machine, origin),
      );
    })().catch(() => undefined),
  );
});

worker.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data as { readonly url?: unknown; readonly sessionId?: unknown } | undefined;
  // Only this site's own pages, and only this machine's: a notification can never open another origin,
  // and one machine's notification can never open another machine's pages. One that names no page it
  // may open still opens the conversation it is about, on this machine.
  const url = notificationTapUrl(
    notificationUrl(data?.url, origin, machine, typeof data?.sessionId === 'string' ? data.sessionId : undefined),
    origin,
  );
  const openWindow = (target: string): Promise<unknown> => worker.clients.openWindow(target);
  event.waitUntil(
    worker.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
      const open = notificationWindow(windows, origin);
      if (open === undefined) return await openWindow(url);
      // Routed by the page itself when it answers (`lib/notification-open.ts`): a navigate here would
      // reload the whole app and make Back cross a document boundary.
      return await openInWindow(open, url, openWindow);
    }),
  );
});
