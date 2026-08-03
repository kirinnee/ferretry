/**
 * SERVICE-WORKER LIFECYCLE AND THE RELOAD CHIP.
 *
 * Ported from kteam `ui/src/hooks/useServiceWorkerUpdate.ts`. The whole
 * lifecycle lives here rather than in the composition root so it is TESTABLE:
 * registration, the visibility-driven update check, the waiting-worker bridge,
 * the no-waiter recovery branch and the single-reload guard are all exported
 * functions over injected surfaces, and the hook is a thin shell over them. The
 * two `applyUpdate` branches are the part most likely to be "simplified" into
 * one, and the no-waiter branch is unreachable in casual manual testing — it
 * needs four sequential deploys — so it has to be provable without a browser.
 *
 * WHAT THE READER SEES: one chip in the app bar (`shell/app-bar.tsx` owns its
 * wording). Never a modal, never an automatic reload. A reload discards unsent
 * composer text and scroll position, so it only ever happens because someone
 * clicked.
 *
 * TWO THINGS CHANGED FOR FERRETRY.
 *
 * The release is INJECTED. kteam read a build-time `define` through a declared
 * global, which made the module unloadable outside its own bundler and tied the
 * feature to one build system. The composition root passes the release it was
 * built as, so this module has no build-time dependency at all.
 *
 * The worker URL is derived from an injected base path rather than assumed to be
 * at the origin root. A public PWA may be served from a sub-path, and a worker
 * registered at the wrong scope silently creates a SECOND registration instead
 * of updating the one that exists. No daemon is involved anywhere here: the
 * worker script is an app asset served by whatever origin served the app, and
 * every daemon URL continues to arrive through runtime pairing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateReason } from '../shell/app-bar.tsx';

/** Releases name a static asset, so the shape is checked before it becomes a URL. */
const RELEASE_PATTERN = /^[A-Za-z0-9._-]+$/u;

/** Normalises an app base path into a service-worker scope. */
export const workerScope = (basePath = '/'): string => {
  const leading = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return leading.endsWith('/') ? leading : `${leading}/`;
};

/**
 * The worker script URL for one release, under the app's own scope. A new script
 * URL per release is what makes the browser update the ONE existing registration
 * rather than adding another.
 */
export const workerUrl = (release: string, basePath = '/'): string => {
  if (!RELEASE_PATTERN.test(release)) throw new Error('a service worker release must be a plain asset name');
  return `${workerScope(basePath)}sw.${release}.js`;
};

export interface ServiceWorkerUpdate {
  /** Non-null when the chip should be shown. */
  readonly updateReady: UpdateReason | null;
  /** Chip click. Idempotent per action — see `applyUpdate`. */
  readonly applyUpdate: () => void;
  /**
   * Raises the recovery chip from outside the hook.
   *
   * A preload failure is not the only way this tab learns it is broken: a
   * rejected lazy import surfaces as a render-time throw that only
   * `shell/chunk-error-boundary.tsx` sees. Both routes must end in the SAME
   * state transition, so the boundary calls this rather than owning a second,
   * subtly different piece of chip state.
   */
  readonly raiseRecovery: () => void;
}

/**
 * The chip's state transition, as a pure function so the priority rule is
 * assertable without a React tree.
 *
 * TWO RULES, AND THEY POINT THE SAME WAY: recovery is never downgraded to
 * update, and update is always UPGRADED to recovery. `recovery` is a statement
 * about this tab — something in it has already failed to load and it is stuck
 * until reloaded — which stays true no matter what the worker does afterwards.
 * Telling a stuck reader "Update ready" would be a lie about the state of their
 * tab in exactly the case where they most need the truth.
 */
export const nextUpdateReason = (previous: UpdateReason | null, next: UpdateReason): UpdateReason => {
  if (previous === 'recovery' || next === 'recovery') return 'recovery';
  return previous ?? next;
};

/**
 * Service workers exist only in secure contexts, and loopback counts as one —
 * which matters here because a daemon is commonly reached over loopback and a
 * naive protocol check would disable the whole feature in normal use.
 * `isSecureContext` already encodes the real rule, so it is what we ask. The
 * container presence check covers private windows, where the property exists on
 * the prototype but the API is unavailable.
 */
export const canRegister = (nav: Partial<Navigator> | undefined, secure: boolean | undefined): boolean =>
  Boolean(secure) && Boolean(nav && 'serviceWorker' in nav && nav.serviceWorker);

/* ---------- the two-branch apply ------------------------------------------- */

/** The minimum registration surface both apply branches need. */
export interface WaitingRegistration {
  readonly waiting: { postMessage: (message: unknown) => void } | null;
}

export type ApplyDecision =
  /** A waiting worker exists: arm this tab's guarded reload, then tell it to skip waiting. */
  | 'skip-waiting'
  /** No waiting worker: reload directly, right now. */
  | 'direct-reload'
  /** Already acted on this chip press — do nothing at all. */
  | 'already-armed';

/**
 * Decides what a chip press does.
 *
 * THE BRANCH IS LOAD-BEARING. The supported degradation path — a tab left open
 * across four deploys whose cache has been pruned — has the registration's
 * ACTIVE worker already at the newest release and `waiting === null`. Posting to
 * a nonexistent waiter is a no-op, so `controllerchange` could never fire, so a
 * single-branch implementation leaves the reader looking at a chip that does
 * nothing, forever, on the one code path that exists to rescue them.
 */
export const applyDecision = (registration: WaitingRegistration | null, alreadyArmed: boolean): ApplyDecision => {
  if (alreadyArmed) return 'already-armed';
  return registration?.waiting ? 'skip-waiting' : 'direct-reload';
};

export interface ApplyDeps {
  /**
   * FRESH lookup, never hook state. Between the chip appearing and the click the
   * worker may have activated on its own (another tab took the update) or the
   * registration may have been replaced, and deciding from a remembered
   * `waiting` reference would take the wrong branch on exactly the races this
   * design exists to survive.
   */
  readonly getRegistration: () => Promise<WaitingRegistration | null>;
  /** Arms the one-shot reload for THIS tab only. */
  readonly armReload: () => void;
  readonly reload: () => void;
  /** Read and set the one-shot guard so exactly one reload happens per press. */
  readonly isArmed: () => boolean;
  readonly setArmed: () => void;
}

/** Runs a chip press. Exported so both branches are directly assertable. */
export const runApplyUpdate = async (deps: ApplyDeps): Promise<ApplyDecision> => {
  if (deps.isArmed()) return 'already-armed';
  // A rejected lookup (private mode revoking mid-session) must not strand the
  // reader: treat it as "no waiter" and reload, which is the recovery branch.
  const registration = await deps.getRegistration().catch(() => null);
  const decision = applyDecision(registration, deps.isArmed());
  if (decision === 'already-armed') return decision;

  deps.setArmed();
  if (decision === 'direct-reload') {
    deps.reload();
    return decision;
  }
  // ORDER MATTERS: arm before posting. Skipping the wait can activate fast
  // enough that `controllerchange` fires before the next statement runs, and a
  // listener attached after that point would miss the only event it exists to
  // hear.
  deps.armReload();
  registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
  return decision;
};

/* ---------- injectable browser surfaces ----------------------------------- */

/** `addEventListener`/`removeEventListener`, and nothing else. */
export interface ListenerTarget {
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
}

export interface WorkerLike extends ListenerTarget {
  readonly state: string;
}

export interface RegistrationLike extends ListenerTarget {
  readonly installing: WorkerLike | null;
  readonly waiting: unknown;
  readonly update: () => Promise<unknown>;
}

/** Only `visibilityState` is read; the listener half is the target above. */
export interface VisibilityTarget extends ListenerTarget {
  readonly visibilityState: string;
}

/**
 * The container surface, covering both the lifecycle and the apply path. The
 * real `navigator.serviceWorker` satisfies it; a suite passes a plain object.
 */
export interface ServiceWorkerContainerLike {
  readonly controller: unknown;
  readonly register: (url: string, options: { scope: string }) => Promise<RegistrationLike>;
  readonly getRegistration: (scope: string) => Promise<WaitingRegistration | null | undefined>;
  readonly addEventListener: (type: string, listener: () => void, options: { once: true }) => void;
}

export interface WorkerLifecycleDeps {
  readonly container: ServiceWorkerContainerLike;
  readonly doc: VisibilityTarget;
  /** The release to register, injected rather than read from a build-time global. */
  readonly release: string;
  readonly basePath?: string;
  /** Called when a chip should appear; repeats are collapsed by the hook. */
  readonly onUpdateReady: (reason: UpdateReason) => void;
  /** Registration failure reporting, injected so a suite can prove it is swallowed. */
  readonly onError: (error: unknown) => void;
}

/**
 * Registers the worker and watches for updates. Returns the cleanup.
 *
 * This IS the hook's effect body. Everything it does is consequential and was
 * previously unprovable: registering at the fixed app scope, raising the chip
 * only once an installing worker reaches `installed` AND a controller exists
 * (without that second condition the FIRST install would offer an update with
 * nothing newer to move to), swallowing a registration rejection instead of
 * breaking the app, re-checking when the tab becomes visible because a long-lived
 * app may never navigate, and removing every listener on unmount.
 */
export const startWorkerLifecycle = (deps: WorkerLifecycleDeps): (() => void) => {
  const { container, doc, release, basePath, onUpdateReady, onError } = deps;
  let cancelled = false;
  let registration: RegistrationLike | null = null;
  const cleanups: (() => void)[] = [];

  const watchInstalling = (worker: WorkerLike | null): void => {
    if (worker === null) return;
    const onState = (): void => {
      // `installed` while another worker controls the page means waiting. Without
      // a controller this is the FIRST install, which is not an update.
      if (worker.state === 'installed' && container.controller) onUpdateReady('update');
    };
    worker.addEventListener('statechange', onState);
    cleanups.push(() => worker.removeEventListener('statechange', onState));
    // Called immediately as well: the worker may already have reached
    // `installed` between the event firing and this listener attaching.
    onState();
  };

  void container
    .register(workerUrl(release, basePath), { scope: workerScope(basePath) })
    .then(registered => {
      // Unmounted while registration was in flight: attaching listeners now would
      // leak them, because the cleanup has already run.
      if (cancelled) return;
      registration = registered;
      // Already waiting when we registered (installed during a previous visit and
      // never taken): the chip must appear without waiting for an event that has
      // already fired.
      if (registered.waiting && container.controller) onUpdateReady('update');
      watchInstalling(registered.installing);
      const onUpdateFound = (): void => watchInstalling(registered.installing);
      registered.addEventListener('updatefound', onUpdateFound);
      cleanups.push(() => registered.removeEventListener('updatefound', onUpdateFound));
    })
    .catch((error: unknown) => {
      // A failed registration must never break the app: without a worker the UI
      // simply has no offline shell and no chip.
      onError(error);
    });

  // UPDATE CHECKS ON RETURN, NOT ON A TIMER. The browser revalidates the worker
  // script on navigation, but this app may stay open for days without ever
  // navigating. Checking when the tab becomes visible ties the check to the
  // moment it can be acted on, and costs one conditional request.
  const onVisibility = (): void => {
    if (doc.visibilityState === 'visible') void registration?.update().catch(() => undefined);
  };
  doc.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => doc.removeEventListener('visibilitychange', onVisibility));

  return () => {
    cancelled = true;
    for (const off of cleanups) off();
  };
};

/** The bundler event a dead lazy chunk surfaces as. */
export const PRELOAD_ERROR_EVENT = 'vite:preloadError';

/**
 * Raises recovery when a lazy chunk cannot be fetched.
 *
 * This is the pruned-generation case: a tab whose release assets are gone from
 * both cache and server tries to lazy-load a pane, the fetch behind the import
 * fails, and the bundler dispatches this event. `preventDefault()` stops the
 * failure becoming an unhandled rejection — it does NOT stop the failure, which
 * still reaches the render as a throw, which is why
 * `shell/chunk-error-boundary.tsx` is the other half of this pair.
 *
 * Watched unconditionally, with no service-worker gate: a preload can fail on a
 * plain redeploy with no worker involved at all, and the reader is just as stuck.
 */
export const startPreloadErrorWatch = (win: ListenerTarget, onRecovery: () => void): (() => void) => {
  const onPreloadError = (event: Event): void => {
    event.preventDefault();
    onRecovery();
  };
  win.addEventListener(PRELOAD_ERROR_EVENT, onPreloadError);
  return () => win.removeEventListener(PRELOAD_ERROR_EVENT, onPreloadError);
};

export interface ApplyEnvironment {
  /** `null` where service workers are unavailable — then a direct reload is all there is. */
  readonly container: ServiceWorkerContainerLike | null;
  readonly basePath?: string;
  readonly reload: () => void;
  readonly isArmed: () => boolean;
  readonly setArmed: () => void;
}

/**
 * Builds the real `ApplyDeps` from browser objects.
 *
 * Separated from the hook so the CONTROLLER ADAPTER is testable: `armReload`
 * attaching a one-shot `controllerchange` listener that reloads is the mechanism
 * the whole skip-waiting branch depends on, and it is invisible to a suite that
 * only checks `runApplyUpdate`'s decisions against a stub.
 */
export const browserApplyDeps = (environment: ApplyEnvironment): ApplyDeps => {
  const { container } = environment;
  return {
    getRegistration: () =>
      container === null
        ? Promise.resolve(null)
        : container.getRegistration(workerScope(environment.basePath)).then(registered => registered ?? null),
    armReload: () => {
      // Scoped to THIS tab, and only on this branch: a tab that never took the
      // waiting-worker path never attaches the listener, so it can never be
      // reloaded out from under its reader by someone else's update. `once` plus
      // the armed guard means exactly one reload.
      container?.addEventListener('controllerchange', () => environment.reload(), { once: true });
    },
    reload: environment.reload,
    isArmed: environment.isArmed,
    setArmed: environment.setArmed,
  };
};

/* ---------- the hook ------------------------------------------------------- */

export interface ServiceWorkerUpdateEnvironment {
  /** The release this bundle was built as. */
  readonly release: string;
  /** The path the app is served under; defaults to the origin root. */
  readonly basePath?: string;
  /** `null` where `canRegister` said no; the recovery chip still works. */
  readonly container: ServiceWorkerContainerLike | null;
  readonly doc: VisibilityTarget;
  readonly win: ListenerTarget;
  readonly reload: () => void;
  readonly onError: (error: unknown) => void;
}

export const useServiceWorkerUpdate = (environment: ServiceWorkerUpdateEnvironment): ServiceWorkerUpdate => {
  const [updateReady, setUpdateReady] = useState<UpdateReason | null>(null);
  const { release, basePath, container, doc, win, reload, onError } = environment;

  /**
   * One-shot reload guard, per chip press. A ref, not state: it must be readable
   * and writable synchronously inside an event handler, and a re-render is
   * neither needed nor wanted. Its job is to make a reload loop impossible — if
   * the navigation after a direct reload itself fails, the fresh page's guard
   * starts false but nothing has armed it, so the error surface takes over
   * instead of a reload cycle.
   */
  const armed = useRef(false);

  const raise = useCallback((reason: UpdateReason) => {
    setUpdateReady(previous => nextUpdateReason(previous, reason));
  }, []);

  // ONE recovery entry point for both halves of the failure surface: the preload
  // watch below and the chunk error boundary's render-time catch.
  const raiseRecovery = useCallback(() => raise('recovery'), [raise]);

  useEffect(() => {
    if (container === null) return;
    return startWorkerLifecycle({ container, doc, release, basePath, onUpdateReady: raise, onError });
  }, [basePath, container, doc, onError, raise, release]);

  useEffect(() => startPreloadErrorWatch(win, raiseRecovery), [raiseRecovery, win]);

  const applyUpdate = useCallback(() => {
    void runApplyUpdate(
      browserApplyDeps({
        container,
        basePath,
        reload,
        isArmed: () => armed.current,
        setArmed: () => {
          armed.current = true;
        },
      }),
    );
  }, [basePath, container, reload]);

  return { updateReady, applyUpdate, raiseRecovery };
};
