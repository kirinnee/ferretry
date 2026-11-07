/**
 * THE SERVICE WORKER'S EXTENSION POINT: where plugin app halves handle Web Push and notification taps (Access's push
 * subscription, Agenda's notifications). Today's worker had those handlers inline; in 5.0 they are each plugin's, and
 * the shell's worker only dispatches.
 *
 * HOW A PLUGIN ADDS ONE: its package ships `app/worker.ts` whose default export is `defineWorkerExtension({...})`
 * (`@ferretry/app/worker`). `scripts/build-release.ts` compiles every such file INTO `sw.verified.js` at build time,
 * so an extension is part of the signed release like every other byte the worker runs.
 *
 * WHAT AN EXTENSION CAN NEVER DO, so the signed-release rules hold whatever a plugin writes:
 * - see a `fetch`, `install`, `activate` or `message` event: those are the release check's alone, and they are
 *   registered before any extension exists;
 * - load code: the build validates every imported module and compiles it into the signed file;
 * - touch the release caches, its state or the registration itself (no `skipWaiting`, no `update`, no `unregister`);
 * - open another origin: {@link WorkerExtensionScope.openWindow} and `navigate` refuse any URL not on this origin.
 * It gets a narrow {@link WorkerExtensionScope} instead. An extension that throws costs only its own event.
 */

/** A push as the worker received it: the payload, parsed as JSON when it is, else `null`. Unvalidated. */
export interface WorkerPush {
  readonly payload: unknown;
}

/** A tap on a notification an extension showed. `data` is what it put there, unvalidated. */
export interface WorkerNotificationTap {
  readonly tag: string;
  readonly data: unknown;
  readonly action: string;
}

/** A shown notification, as `getNotifications` lists it. */
export interface WorkerNotification {
  readonly tag: string;
  readonly data: unknown;
  close(): void;
}

/** An open window of this app, as the worker sees it. */
export interface WorkerWindow {
  readonly url: string;
  readonly focused: boolean;
  readonly visibilityState: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
  postMessage(message: unknown): void;
}

export interface WorkerNotificationOptions {
  readonly body?: string;
  readonly tag?: string;
  readonly data?: unknown;
  readonly icon?: string;
  readonly badge?: string;
  readonly renotify?: boolean;
  readonly silent?: boolean;
  readonly timestamp?: number;
}

/** What an extension may use. Built by the worker per event; every URL it opens is held to this origin. */
export interface WorkerExtensionScope {
  /** This app's origin. */
  readonly origin: string;
  /** The registration's scope URL (`/` app-wide, or `/push/<daemonId>/` for one machine's push subscription). */
  readonly registrationScope: string;
  now(): number;
  showNotification(title: string, options: WorkerNotificationOptions): Promise<void>;
  getNotifications(filter?: { readonly tag?: string }): Promise<readonly WorkerNotification[]>;
  /** This app's open windows, the uncontrolled ones included. */
  windows(): Promise<readonly WorkerWindow[]>;
  /** Opens a window on THIS origin; any other URL is refused and nothing opens. */
  openWindow(url: string): Promise<void>;
}

export interface WorkerExtension {
  /** The owning plugin's id. */
  readonly id: string;
  /**
   * A push. Answer `true` when this extension handled it (and showed something: a push that shows nothing is
   * penalised by the browser and the subscription eventually revoked), `false` to let the next extension try.
   */
  readonly push?: (push: WorkerPush, scope: WorkerExtensionScope) => Promise<boolean> | boolean;
  /** A tap. Answer `true` when this extension handled it. */
  readonly notificationClick?: (tap: WorkerNotificationTap, scope: WorkerExtensionScope) => Promise<boolean> | boolean;
}

/** `export default defineWorkerExtension({ id: 'agenda', push: … })` in a plugin's `app/worker.ts`. */
export function defineWorkerExtension(extension: WorkerExtension): WorkerExtension {
  return Object.freeze({ ...extension });
}

/** What the worker shows for a push no extension handled, so the subscription is never left showing nothing. */
export const UNHANDLED_PUSH = Object.freeze({ title: 'Ferretry', body: 'Something is waiting for you.' });

/** Whether a URL resolves to this origin; the worker opens nothing else. */
export function onThisOrigin(url: string, origin: string): string | undefined {
  try {
    const resolved = new URL(url, origin);
    return resolved.origin === origin ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Dispatches the two events to the extensions, in the order the build listed them (plugin start order). Pure apart
 * from the scope it is handed, so it is tested without a worker.
 */
export class WorkerExtensionHost {
  readonly #extensions: readonly WorkerExtension[];

  constructor(extensions: readonly WorkerExtension[]) {
    // One extension per plugin; a second with the same id is a build bug, and the first wins.
    const byId = new Map<string, WorkerExtension>();
    for (const extension of extensions) if (!byId.has(extension.id)) byId.set(extension.id, extension);
    this.#extensions = [...byId.values()];
  }

  get ids(): readonly string[] {
    return this.#extensions.map(extension => extension.id);
  }

  async push(push: WorkerPush, scope: WorkerExtensionScope): Promise<void> {
    for (const extension of this.#extensions) {
      if (extension.push === undefined) continue;
      try {
        if ((await extension.push(push, scope)) === true) return;
      } catch {
        // That extension's event only; the next one still gets the push.
      }
    }
    await scope.showNotification(UNHANDLED_PUSH.title, { body: UNHANDLED_PUSH.body });
  }

  async notificationClick(tap: WorkerNotificationTap, scope: WorkerExtensionScope): Promise<void> {
    for (const extension of this.#extensions) {
      if (extension.notificationClick === undefined) continue;
      try {
        if ((await extension.notificationClick(tap, scope)) === true) return;
      } catch {
        // As above.
      }
    }
    // Nobody claimed it: open (or focus) the app itself, never anything a notification named.
    const open = (await scope.windows())[0];
    if (open !== undefined) await open.focus();
    else await scope.openWindow('/app/');
  }
}

/** The worker globals {@link extensionScope} narrows, typed here rather than through the WebWorker lib. */
export interface WorkerGlobals {
  readonly origin: string;
  readonly now: () => number;
  readonly registration: {
    readonly scope: string;
    showNotification(title: string, options: WorkerNotificationOptions): Promise<void>;
    getNotifications(filter?: { readonly tag?: string }): Promise<readonly WorkerNotification[]>;
  };
  readonly clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WorkerWindow[]>;
    openWindow(url: string): Promise<unknown>;
  };
}

/** The narrow scope an extension gets: no fetch, no caches, no registration control, and this origin only. */
export function extensionScope(globals: WorkerGlobals): WorkerExtensionScope {
  const sameOrigin = (url: string): string | undefined => onThisOrigin(url, globals.origin);
  const scope: WorkerExtensionScope = {
    origin: globals.origin,
    registrationScope: globals.registration.scope,
    now: () => globals.now(),
    showNotification: (title, options) => globals.registration.showNotification(title, options),
    getNotifications: filter => globals.registration.getNotifications(filter),
    windows: async () => {
      const windows = await globals.clients.matchAll({ type: 'window', includeUncontrolled: true });
      return windows
        .filter(window => sameOrigin(window.url) !== undefined)
        .map(window => ({
          url: window.url,
          focused: window.focused,
          visibilityState: window.visibilityState,
          focus: () => window.focus(),
          navigate: async (url: string) => {
            const target = sameOrigin(url);
            return target === undefined ? undefined : await window.navigate(target);
          },
          postMessage: (message: unknown) => window.postMessage(message),
        }));
    },
    openWindow: async url => {
      const target = sameOrigin(url);
      if (target !== undefined) await globals.clients.openWindow(target);
    },
  };
  return Object.freeze(scope);
}
