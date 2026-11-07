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
 *   - message: answer the page's "check now", "what happened" and "is this new worker signed?".
 *
 * Push notifications are not the shell's: their handlers come back with the plugins that own them (Access's push
 * subscription, Agenda's notification filter). GAP: there is no worker-side extension point for them yet.
 *
 * Three values are compiled in by the build and nothing else: the release public key from
 * `packages/app/release-signing-key.pub`, the app's rewrites from `public/_redirects`, and its header rules from
 * `public/_headers`. The key is the ONE anchor: nothing this worker stores is trusted, because any page on this origin
 * can write IndexedDB and Cache Storage.
 */

import type { ReleaseHeaderRule } from '../release/headers.ts';
import { answerReleaseRequest, parseReleaseRequest, ReleaseKeeper } from '../release/keeper.ts';
import { isLoopbackHost } from '../release/loopback.ts';
import type { ReleaseRewrite } from '../release/manifest.ts';
import { CacheStorageReleaseCaches, FetchReleaseNetwork, IndexedDbReleaseState } from '../release/storage.ts';

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
interface WorkerScope {
  readonly location: { readonly origin: string; readonly hostname: string; readonly href: string };
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

const worker = globalThis as unknown as WorkerScope;
const origin = worker.location.origin;

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
