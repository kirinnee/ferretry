/**
 * WHAT THE PAGE HEARS FROM THE RELEASE CHECK, AND THE REPLACED-WORKER ALARM.
 *
 * The service worker (`src/worker/service-worker.ts`) verifies every release before it serves one;
 * this hook is how the reader finds out what it concluded. It asks the active worker for a check on
 * start and whenever the tab becomes visible, raises the existing "Update ready" chip when a verified
 * release was installed, and raises a notice when one was refused.
 *
 * THE ALARM. A browser installs a changed worker script on its own schedule, and a worker is the
 * verifier — so a deploy that ships its own worker replaces the check itself. The running, verified
 * worker is therefore asked about every NEW worker the moment the browser starts installing one: it
 * fetches that script and compares its hash to the signed release. A worker no signed release lists
 * — or an audit nobody answers — raises a loud warning. This SOMETIMES detects the replacement and
 * never prevents it: it runs only while a verified tab is open, a worker that skips waiting and takes
 * the tab over wins the race, and the warning is page state that a reload clears
 * (`docs/pwa-release-signing.md`). `onUnsignedWorker` is the seam the daemon's audit log attaches
 * to; nothing records it yet.
 *
 * EVERY COPY OF THE WORKER, NOT ONLY THE PAGE'S. Each paired machine has its own registration of the
 * same signed file for its push subscription (`lib/push-scope.ts`). Those copies show notifications and
 * open pages, so a replaced one is as bad as a replaced app-wide one: each is audited the same way —
 * its active, waiting and installing scripts when the tab starts or becomes visible, and every new
 * install as it begins.
 *
 * Every browser surface is injected, exactly as in `use-service-worker-update.ts`, so each branch is
 * provable without a browser.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReleaseOutcome, ReleaseReplyMessage, ReleaseRequestMessage } from '../lib/release-keeper.ts';
import { isPushScope } from '../lib/push-scope.ts';
import { parseReleaseReply } from '../lib/release-keeper.ts';
import type { ReleaseRefusal } from '../lib/release-verification.ts';
import type { UpdateReason } from '../shell/app-bar.tsx';
import type { ListenerTarget, VisibilityTarget } from './use-service-worker-update.ts';

/** What the notice says. `null` is "nothing to say". */
export type ReleaseNotice =
  | { readonly kind: 'refused'; readonly refusal: ReleaseRefusal; readonly hadRelease: boolean }
  | { readonly kind: 'unsigned-worker' };

/** A worker that can be asked something. */
export interface ReleaseWorkerLike {
  readonly scriptURL: string;
  postMessage(message: unknown, transfer: readonly unknown[]): void;
}

export interface ReleaseRegistrationLike extends ListenerTarget {
  readonly active: ReleaseWorkerLike | null;
  readonly installing: ReleaseWorkerLike | null;
  readonly waiting: ReleaseWorkerLike | null;
}

export interface ReleaseContainerLike {
  readonly controller: unknown;
  readonly ready: Promise<ReleaseRegistrationLike>;
  /** Every registration on this origin, so each machine's push worker is audited too. */
  readonly getRegistrations?: () => Promise<readonly unknown[]>;
}

const isPushRegistration = (value: unknown): value is ReleaseRegistrationLike & { readonly scope: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { scope?: unknown }).scope === 'string' &&
  isPushScope((value as { scope: string }).scope) &&
  typeof (value as { addEventListener?: unknown }).addEventListener === 'function';

/** One port pair, as `MessageChannel` makes it. */
export interface ReleaseChannelLike {
  readonly port1: { onmessage: ((event: MessageEvent) => void) | null; close(): void };
  readonly port2: unknown;
}

/** A worker that never answers is treated as the worst answer, after this long. */
export const RELEASE_ASK_TIMEOUT_MS = 60_000;

export interface ReleaseAskDeps {
  readonly channel: () => ReleaseChannelLike;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
}

/** Sends one request and resolves with the parsed reply, or `null` for silence or nonsense. */
export const askReleaseWorker = (
  worker: ReleaseWorkerLike,
  message: ReleaseRequestMessage,
  deps: ReleaseAskDeps,
): Promise<ReleaseReplyMessage | null> =>
  new Promise(resolve => {
    const channel = deps.channel();
    const finish = (reply: ReleaseReplyMessage | null): void => {
      deps.clearTimer(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(reply);
    };
    const timer = deps.setTimer(() => finish(null), RELEASE_ASK_TIMEOUT_MS);
    channel.port1.onmessage = event => finish(parseReleaseReply(event.data));
    worker.postMessage(message, [channel.port2]);
  });

/** The notice a check's outcome calls for, if any. */
export const noticeForOutcome = (outcome: ReleaseOutcome | null): ReleaseNotice | null =>
  outcome?.status === 'refused' ? { kind: 'refused', refusal: outcome.refusal, hadRelease: outcome.hadRelease } : null;

/** The alarm outranks everything: a later, calmer check must never hide it. */
export const nextReleaseNotice = (previous: ReleaseNotice | null, next: ReleaseNotice | null): ReleaseNotice | null =>
  previous?.kind === 'unsigned-worker' ? previous : (next ?? previous);

/** What the audit seam is told about an unsigned worker. */
interface UnsignedWorkerEvent {
  readonly scriptUrl: string;
}

export interface ReleaseIntegrityDeps {
  readonly container: ReleaseContainerLike;
  readonly doc: VisibilityTarget;
  readonly ask: (worker: ReleaseWorkerLike, message: ReleaseRequestMessage) => Promise<ReleaseReplyMessage | null>;
  readonly onNotice: (notice: ReleaseNotice) => void;
  readonly onUpdateReady: (reason: UpdateReason) => void;
  /** The audit seam: called once per unsigned worker script. */
  readonly onUnsignedWorker?: (event: UnsignedWorkerEvent) => void;
}

/** Starts the checks and the alarm. Returns the cleanup. */
export const startReleaseIntegrity = (deps: ReleaseIntegrityDeps): (() => void) => {
  const { container, doc, ask, onNotice, onUpdateReady, onUnsignedWorker } = deps;
  let cancelled = false;
  let registration: ReleaseRegistrationLike | null = null;
  const audited = new Set<string>();
  const cleanups: (() => void)[] = [];

  const check = async (): Promise<void> => {
    const active = registration?.active ?? null;
    if (active === null) return;
    const reply = await ask(active, { type: 'fy-release-check' });
    if (cancelled || reply?.type !== 'fy-release-outcome') return;
    const notice = noticeForOutcome(reply.outcome);
    if (notice !== null) onNotice(notice);
    // A first install has no controller and nothing newer to move to; that is not an update.
    if (reply.outcome?.status === 'updated' && container.controller) onUpdateReady('update');
  };

  const audit = async (candidate: ReleaseWorkerLike | null): Promise<void> => {
    const active = registration?.active ?? null;
    if (candidate === null || active === null || candidate === active || audited.has(candidate.scriptURL)) return;
    audited.add(candidate.scriptURL);
    const reply = await ask(active, { type: 'fy-release-audit-worker', scriptUrl: candidate.scriptURL });
    if (cancelled || (reply?.type === 'fy-release-worker-audit' && reply.signed)) return;
    // Allow a later, genuinely new copy of the same URL to be audited again.
    audited.delete(candidate.scriptURL);
    onNotice({ kind: 'unsigned-worker' });
    onUnsignedWorker?.({ scriptUrl: candidate.scriptURL });
  };

  const watched = new Set<unknown>();
  const watchPushWorkers = async (): Promise<void> => {
    const all = (await container.getRegistrations?.().catch(() => [])) ?? [];
    for (const push of all) {
      if (cancelled || !isPushRegistration(push)) continue;
      void audit(push.active);
      void audit(push.waiting);
      void audit(push.installing);
      if (watched.has(push)) continue;
      watched.add(push);
      const onPushUpdateFound = (): void => void audit(push.installing);
      push.addEventListener('updatefound', onPushUpdateFound);
      cleanups.push(() => push.removeEventListener('updatefound', onPushUpdateFound));
    }
  };

  void container.ready.then(ready => {
    if (cancelled) return;
    registration = ready;
    const onUpdateFound = (): void => void audit(ready.installing);
    ready.addEventListener('updatefound', onUpdateFound);
    cleanups.push(() => ready.removeEventListener('updatefound', onUpdateFound));
    void audit(ready.installing);
    void audit(ready.waiting);
    void check();
    void watchPushWorkers();
  });

  const onVisibility = (): void => {
    if (doc.visibilityState !== 'visible') return;
    void check();
    void watchPushWorkers();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => doc.removeEventListener('visibilitychange', onVisibility));

  return () => {
    cancelled = true;
    for (const off of cleanups) off();
  };
};

export interface ReleaseIntegrityEnvironment {
  /** `null` where service workers are unavailable: nothing is checked and nothing is shown. */
  readonly container: ReleaseContainerLike | null;
  readonly doc: VisibilityTarget;
  readonly ask: ReleaseIntegrityDeps['ask'];
  readonly onUpdateReady: (reason: UpdateReason) => void;
  readonly onUnsignedWorker?: (event: UnsignedWorkerEvent) => void;
}

export interface ReleaseIntegrity {
  readonly notice: ReleaseNotice | null;
  readonly dismiss: () => void;
}

export const useReleaseIntegrity = (environment: ReleaseIntegrityEnvironment): ReleaseIntegrity => {
  const [notice, setNotice] = useState<ReleaseNotice | null>(null);
  const { container, doc, ask, onUpdateReady, onUnsignedWorker } = environment;

  const raise = useCallback((next: ReleaseNotice) => setNotice(previous => nextReleaseNotice(previous, next)), []);
  const dismiss = useCallback(() => setNotice(null), []);

  useEffect(() => {
    if (container === null) return;
    return startReleaseIntegrity({
      container,
      doc,
      ask,
      onNotice: raise,
      onUpdateReady,
      ...(onUnsignedWorker === undefined ? {} : { onUnsignedWorker }),
    });
  }, [ask, container, doc, onUnsignedWorker, onUpdateReady, raise]);

  return { notice, dismiss };
};

/* ---------- the browser binding ------------------------------------------- */

/** The browser objects the composition root hands over; each one may be missing. */
export interface ReleaseBrowser {
  readonly navigator: Partial<Navigator> | undefined;
  readonly secure: boolean | undefined;
  readonly MessageChannel: (new () => ReleaseChannelLike) | undefined;
}

/**
 * The real container, or `null` where there is no worker to ask: an insecure page, a private window
 * without the API, or a browser without `MessageChannel`. The SAME rule decides registration
 * (`canRegister`), so the page never asks a worker it could not have registered.
 */
export const releaseContainer = (browser: ReleaseBrowser): (ReleaseContainerLike & object) | null => {
  const container = browser.navigator?.serviceWorker;
  if (browser.secure !== true || container === undefined || container === null) return null;
  if (browser.MessageChannel === undefined) return null;
  return container as unknown as ReleaseContainerLike;
};

/** `askReleaseWorker` bound to the browser's own channel and timers. */
export const browserReleaseAsk =
  (Channel: new () => ReleaseChannelLike): ReleaseIntegrityDeps['ask'] =>
  (worker, message) =>
    askReleaseWorker(worker, message, {
      channel: () => new Channel(),
      setTimer: (run, ms) => globalThis.setTimeout(run, ms),
      clearTimer: timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
