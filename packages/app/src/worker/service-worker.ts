/**
 * THE SERVICE WORKER — the composition root of the signed-release check, built to `/sw.verified.js` by
 * `scripts/build-release.ts`. Copied from today's PWA `worker/service-worker.ts` (docs/pwa-release-signing.md).
 *
 * Wiring only, like `main.tsx`: every decision is in `release/keeper.ts` and `release/verification.ts`, and every
 * browser object is bound here, once, to the ports those modules take.
 *
 * What it does, in order:
 *   - install: download, verify and cache the release the site serves now;
 *   - activate: take control of the pages that are open, so the first install protects them now;
 *   - fetch: re-check the site on every page load; once a verified release exists, answer EVERY same-origin page
 *     load from it and every subresource it lists, from bytes re-hashed on the way out, with the headers `_headers`
 *     names; leave everything else — every daemon request included — exactly as the page sent it;
 *   - message: answer the page's "check now", "what happened" and "is this new worker signed?";
 *   - push / notificationclick: read the push as the kernel's message (`readPushMessage`). A SHOW is filtered by this device's
 *     own document (`filter-document.ts`), titled for the machine whose registration this copy is, filed under that
 *     machine's tag, grouped and replaced in place, and carries the page it named only when the shell's route parse
 *     accepts it (`notify-group.ts`, `notifications.ts`). A CLEAR names tags and nothing else and takes those lines down
 *     (`push-clear.ts`). On a tap open that page — never another origin or machine's.
 *
 * NO PLUGIN CODE RUNS IN THIS WORKER. Every byte is the shell's own: the build compiles this file and nothing else, and
 * FAILS if any `packages/{core,plugins}/<id>/app/worker.ts` exists. Code evaluated in this realm could rewrite the
 * globals the release check serves through (`Response`, `crypto.subtle`, `caches`, …) before any event arrives, so no
 * name list can make it safe. A plugin that needs worker behaviour asks for it as declarative data the worker
 * interprets, in its own contract, later.
 *
 * The release listeners register first, and install, activate and fetch stop every later listener, so nothing
 * registered after them can answer a fetch, an install or an activate.
 *
 * Three values are compiled in by the build and nothing else: the release public key from
 * `packages/app/release-signing-key.pub`, the app's rewrites from `public/_redirects`, and its header rules from
 * `public/_headers`. The key is the ONE anchor: nothing this worker stores is trusted, because any page on this origin
 * can write IndexedDB and Cache Storage.
 */

import type { ReleaseHeaderRule } from '../release/headers.ts';
import { answerReleaseRequest, parseReleaseRequest, ReleaseKeeper } from '../release/keeper.ts';
import { readPushMessage } from '@ferretry/kernel/contract/push-envelope';
import { shouldShowPush } from '@ferretry/kernel/contract/notification-filter';
import { isLoopbackHost } from '../release/loopback.ts';
import type { ReleaseRewrite } from '../release/manifest.ts';
import { CacheStorageReleaseCaches, FetchReleaseNetwork, IndexedDbReleaseState } from '../release/storage.ts';
import { readFilterDocument } from './filter-document.ts';
import { filteredPushNotification, machineShow, showGroupedNotification } from './notify-group.ts';
import {
  notificationBrand,
  notificationClick,
  notificationWindow,
  openInWindow,
  pushMachineOf,
  unreadablePush,
} from './notifications.ts';
import { applyClear, RecentlyCleared, settleIfCleared, type ClearRegistration } from './push-clear.ts';

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
/** What a registration holds that the push handler uses: showing, listing and closing lines, and its subscription. */
type PushRegistration = ClearRegistration & {
  readonly scope: string;
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
};
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
  readonly registration: PushRegistration;
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
/** The order pushes reached this worker, and what each clear took down (`push-clear.ts`). */
const recentlyCleared = new RecentlyCleared(() => Date.now());

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
  event.stopImmediatePropagation();
  // An install never FAILS on a refused release: a worker that failed to install could not raise
  // the alarm about the next one, and the network still serves the page exactly as it would have.
  event.waitUntil(keeper.update().catch(() => undefined));
});

worker.addEventListener('activate', event => {
  event.stopImmediatePropagation();
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener('fetch', event => {
  // No later listener ever answers a fetch.
  event.stopImmediatePropagation();
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Not this site: a daemon, a relay, anything else. Never touched: no answer, so the browser sends it itself.
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
  // Its place in arrival order, taken before anything is awaited (`RecentlyCleared`).
  const place = recentlyCleared.arrived();
  let json: unknown = null;
  try {
    json = event.data?.json() ?? null;
  } catch {
    json = null;
  }
  // The kernel's message, picked by name and parsed strictly; `null` is unreadable. Total — it never throws.
  const message = readPushMessage(json);
  const registration = worker.registration;
  // A subscription that receives a push and shows nothing is penalised by the browser and revoked: whatever goes wrong
  // below, something quiet is shown rather than nothing.
  const plain = async (): Promise<void> => {
    const unreadable = unreadablePush(machine);
    await registration.showNotification(unreadable.title, { ...notificationBrand(), body: unreadable.body });
  };
  event.waitUntil(
    (async () => {
      if (message === null) return await plain();
      if (message.type === 'clear') {
        // A handled item: its lines come down here, never through the filter — a clear carries nothing to hide.
        const { clear } = message;
        await recentlyCleared.serial(
          async () => await applyClear(registration, clear, machine, origin, { recent: recentlyCleared, place }),
        );
        return;
      }
      const { show } = message;
      // This device's own filter is the only thing left that decides (a service worker cannot read `localStorage`): the
      // document Agenda keeps in IndexedDB, evaluated by the kernel's one decision so the page and the worker agree.
      const document = await readFilterDocument(globalThis.indexedDB);
      const visible = shouldShowPush(
        document,
        { kind: show.kind ?? null, daemon: machine?.daemonId ?? null },
        new Date(),
      );
      if (!visible) {
        // The least-bad compliant answer: quiet, never the suppressed words, one fixed tag per machine.
        const quiet = filteredPushNotification(machine, origin);
        await registration.showNotification(quiet.title, quiet.options);
        return;
      }
      const shown = machineShow(show, machine, origin);
      // One show or clear at a time, so a clear always sees this line once it is up; and a clear that arrived after this
      // push, while it read its filter, settles it as the clear would have instead of letting it show.
      await recentlyCleared.serial(async () => {
        if (
          shown.tag !== undefined &&
          (await settleIfCleared(registration, shown.tag, recentlyCleared, place, machine, origin))
        )
          return;
        await showGroupedNotification(registration, shown);
      });
    })().catch(async () => {
      // A show that failed part-way still leaves the reader something (never for a clear, which has nothing to say).
      if (message?.type !== 'clear') await plain().catch(() => undefined);
    }),
  );
});

worker.addEventListener('notificationclick', event => {
  event.notification.close();
  // Only this site's own pages, and only this machine's: a notification can never open another origin, and one
  // machine's notification can never open another machine's pages.
  const { url, tag } = notificationClick(event.notification.data, origin, machine);
  const openWindow = (target: string): Promise<unknown> => worker.clients.openWindow(target);
  event.waitUntil(
    worker.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
      const open = notificationWindow(windows, origin);
      if (open === undefined) return await openWindow(url);
      // Routed by the page itself when it answers (`notification-open.ts`): a navigate here would reload the whole app.
      return await openInWindow(open, url, openWindow, undefined, tag);
    }),
  );
});
