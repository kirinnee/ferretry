/**
 * KEEPING THE CHATS A READER IS LIKELY TO SWITCH TO FRESH, SO SWITCHING IS INSTANT.
 *
 * Only the OPEN chat used to receive live updates; every other chat opened on whatever this device
 * cached last time and said "Updating…" until a round trip answered. This reads the likely-next chats in
 * the background, into the same cache (`session-cache.ts`), so switching into one draws the current tail
 * in the first frame.
 *
 * WHICH CHATS — and nothing else: the INTERACTIVE sessions, plus the {@link SESSION_CACHE_LIMITS}
 * `transcripts` (40) most recently OPENED. An auto / sub-ferret session that is in neither is never read
 * here. The open chat is excluded too: its own refresh already keeps it live. The cache holds at most 40
 * opened transcripts plus the interactive ones (few) — hard-capped at `background` (40) as a backstop.
 *
 * WHEN — from the signal the app already has: the fleet store's session list, which the live fleet feed
 * keeps current (`fleet-feed.ts`). No new polling. A session's `journalSequence` is the cursor: the
 * cache keeps the cursor each transcript was read at, and a session whose cursor still matches is NOT
 * read. The daemon's log read has no "since" form, so a changed session is re-read as its bounded tail
 * (through the same pooled client as the open chat, so an unchanged tail is a `304`) and replaces the
 * cached tail; what is saved is that tail, not a growing log.
 *
 * HOW LITTLE: a burst of changes to one session is ONE read ({@link BACKGROUND_FRESH_LIMITS.debounceMs}
 * after the burst, or {@link BACKGROUND_FRESH_LIMITS.maxWaitMs} at the latest), a session is read at most
 * once per {@link BACKGROUND_FRESH_LIMITS.minGapMs}, and at most
 * {@link BACKGROUND_FRESH_LIMITS.concurrency} reads are in flight. Nothing is read while the tab is
 * hidden (a wake re-checks everything), while the browser asks to save data or the link is slow, or — if
 * the reader chose it — while on a cellular link. The reader can turn it off per device.
 *
 * WHAT IT NEVER DOES: write for a machine that was unpaired or re-paired while a read was in flight (the
 * cache's generation fence), or retry a read the machine refused — a caller may background-read exactly
 * what it could read in the foreground, because the read IS the foreground read, on the same credential.
 */

import { FyHttpError } from '@ferretry/protocol/client';
import type { SessionView } from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';
import type { FleetSnapshot } from './fleet-store.ts';
import type { CachedTranscript, SessionCache } from './session-cache.ts';

export interface BackgroundFreshLimits {
  /** How long a session's changes are let settle before the one read they ask for. */
  readonly debounceMs: number;
  /** The longest a continuously changing session waits for its read. */
  readonly maxWaitMs: number;
  /** The shortest gap between two reads of the same session. */
  readonly minGapMs: number;
  /** Reads in flight at once, across every machine. */
  readonly concurrency: number;
}

export const BACKGROUND_FRESH_LIMITS: BackgroundFreshLimits = {
  debounceMs: 2_000,
  maxWaitMs: 15_000,
  minGapMs: 20_000,
  concurrency: 2,
};

/** This device's two choices (Settings › This device › Keep recent chats fresh). */
export interface BackgroundFreshSettings {
  readonly enabled: boolean;
  readonly notOnCellular: boolean;
}

/** What the browser says about the page and the link, injectable so a suite needs no browser. */
export interface BackgroundFreshEnvironment {
  readonly visible: () => boolean;
  /** The browser asks for less data (`saveData`) or the link is slow (2g or worse). */
  readonly constrained: () => boolean;
  /** The link is cellular. `false` where the browser cannot say (Safari, Firefox): the choice then has nothing to act on. */
  readonly cellular: () => boolean;
  /** Registers for a change in visibility or in the link; returns how to stop. */
  readonly onWake: (listener: () => void) => () => void;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
}

interface NetworkInformation {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
  readonly type?: string;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface BackgroundFreshGlobals {
  readonly document?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  readonly navigator?: { readonly connection?: NetworkInformation };
}

/** The page's own signals; `navigator.connection` is feature-detected (Chromium only). */
export const browserBackgroundFreshEnvironment = (
  globals: BackgroundFreshGlobals = globalThis as unknown as BackgroundFreshGlobals,
): BackgroundFreshEnvironment => ({
  visible: () => globals.document?.visibilityState !== 'hidden',
  constrained: () => {
    const connection = globals.navigator?.connection;
    return (
      connection?.saveData === true || connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g'
    );
  },
  cellular: () => globals.navigator?.connection?.type === 'cellular',
  onWake: listener => {
    const connection = globals.navigator?.connection;
    globals.document?.addEventListener('visibilitychange', listener);
    connection?.addEventListener('change', listener);
    return () => {
      globals.document?.removeEventListener('visibilitychange', listener);
      connection?.removeEventListener('change', listener);
    };
  },
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  now: () => Date.now(),
});

/**
 * The sessions worth keeping fresh on one machine: every INTERACTIVE one, and every other that is among
 * the most recently opened. Pure, so the membership rule is one testable sentence.
 */
export const backgroundFreshSessions = (
  sessions: readonly SessionView[],
  recentlyOpened: (sessionId: string) => boolean,
): readonly SessionView[] =>
  sessions.filter(session => session.config.mode === 'interactive' || recentlyOpened(session.config.id));

/**
 * Whether a cached transcript already shows everything the session's journal holds: the cache saw it at
 * exactly the position the session is at now. A daemon that reports no `journalSequence` is never current
 * — nothing proves it.
 */
export const transcriptIsCurrent = (
  cached: Pick<CachedTranscript, 'cursor'> | undefined,
  view: SessionView | undefined,
): boolean =>
  cached?.cursor !== undefined && view?.journalSequence !== undefined && cached.cursor === view.journalSequence;

export interface BackgroundFreshInput {
  readonly fleet: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): FleetSnapshot;
  };
  readonly cache: SessionCache;
  readonly connections: () => readonly DaemonConnection[];
  /** One session's log, through the app's pooled client — never a request of this module's own. */
  readonly readLog: (daemon: DaemonConnection, sessionId: string) => Promise<string>;
  readonly settings: { get(): BackgroundFreshSettings; subscribe(listener: () => void): () => void };
  readonly environment?: BackgroundFreshEnvironment;
  readonly limits?: BackgroundFreshLimits;
}

interface Pending {
  readonly firstAt: number;
  timer: unknown;
}

const SETTLED: ReadonlySet<string> = new Set();

/** A refusal is the machine saying this caller may not read it: not worth asking again this document. */
const refused = (reason: unknown): boolean =>
  reason instanceof FyHttpError && (reason.status === 401 || reason.status === 403 || reason.status === 404);

export class BackgroundChatFreshener {
  readonly #input: BackgroundFreshInput;
  readonly #environment: BackgroundFreshEnvironment;
  readonly #limits: BackgroundFreshLimits;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<string, Pending>();
  readonly #queue: string[] = [];
  /** The cursor each session was last scheduled at, so only a CHANGE schedules a read. */
  readonly #seen = new Map<string, number | undefined>();
  readonly #lastRead = new Map<string, number>();
  readonly #refused = new Set<string>();
  readonly #scopes = new Map<string, DaemonSessionScope>();
  #running = 0;
  #open: string | null = null;
  #inFlight: ReadonlySet<string> = SETTLED;
  #stop: (() => void) | null = null;
  /** Bumped by a stop, so a read still in flight when the freshener was stopped writes nothing. */
  #run = 0;

  constructor(input: BackgroundFreshInput) {
    this.#input = input;
    this.#environment = input.environment ?? browserBackgroundFreshEnvironment();
    this.#limits = input.limits ?? BACKGROUND_FRESH_LIMITS;
  }

  /** Starts listening to the fleet. Idempotent; the returned function stops it. */
  start(): () => void {
    if (this.#stop !== null) return this.#stop;
    const run = ++this.#run;
    void this.#input.cache.warm().then(() => {
      if (this.#run === run) this.#scan();
    });
    const stops = [
      this.#input.fleet.subscribe(() => this.#scan()),
      this.#input.settings.subscribe(() => this.#scan()),
      this.#environment.onWake(() => this.#scan()),
    ];
    this.#stop = () => {
      this.#run += 1;
      for (const stop of stops) stop();
      for (const { timer } of this.#pending.values()) this.#environment.clearTimeout(timer);
      this.#pending.clear();
      this.#queue.length = 0;
      this.#seen.clear();
      this.#stop = null;
    };
    return this.#stop;
  }

  /** The chat on screen, which keeps itself live and so is not also read here. `null`: none. */
  setOpen(scope: DaemonSessionScope | null): void {
    this.#open = scope === null ? null : daemonSessionKey(scope);
    if (this.#open !== null) this.#drop(this.#open);
    else this.#scan();
  }

  /** The sessions whose background read is in flight right now: for the tiny dot on a switch. */
  readonly getSnapshot = (): ReadonlySet<string> => this.#inFlight;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  isCatchingUp(scope: DaemonSessionScope): boolean {
    return this.#inFlight.has(daemonSessionKey(scope));
  }

  /** Whether any background read may start now: the choice is on, the page is shown, the link allows it. */
  #allowed(): boolean {
    const settings = this.#input.settings.get();
    return (
      settings.enabled &&
      this.#environment.visible() &&
      !this.#environment.constrained() &&
      !(settings.notOnCellular && this.#environment.cellular())
    );
  }

  #scan(): void {
    if (this.#stop === null) return;
    if (!this.#allowed()) {
      // Pausing forgets what was seen, so the wake finds every change again rather than none.
      this.#seen.clear();
      for (const key of [...this.#pending.keys()]) this.#drop(key);
      return;
    }
    const snapshot = this.#input.fleet.getSnapshot();
    const wanted = new Set<string>();
    for (const daemon of this.#input.connections()) {
      const slice = snapshot.daemons.get(daemon.daemonId);
      if (slice?.sessions == null) continue;
      for (const session of backgroundFreshSessions(slice.sessions, id =>
        this.#input.cache.isRecentlyOpened({ daemonId: daemon.daemonId, sessionId: id }),
      )) {
        const scope: DaemonSessionScope = { daemonId: daemon.daemonId, sessionId: session.config.id };
        const key = daemonSessionKey(scope);
        if (session.config.mode === 'interactive') wanted.add(this.#input.cache.keyOf(scope));
        if (key === this.#open || this.#refused.has(key)) continue;
        if (this.#seen.has(key) && this.#seen.get(key) === session.journalSequence) continue;
        this.#seen.set(key, session.journalSequence);
        this.#scopes.set(key, scope);
        this.#schedule(key);
      }
    }
    this.#input.cache.retainBackground(wanted);
  }

  #schedule(key: string): void {
    const now = this.#environment.now();
    const before = this.#pending.get(key);
    if (before !== undefined) this.#environment.clearTimeout(before.timer);
    const firstAt = before?.firstAt ?? now;
    const settle = Math.min(this.#limits.debounceMs, Math.max(0, firstAt + this.#limits.maxWaitMs - now));
    const gap = Math.max(0, (this.#lastRead.get(key) ?? Number.NEGATIVE_INFINITY) + this.#limits.minGapMs - now);
    const entry: Pending = { firstAt, timer: undefined };
    entry.timer = this.#environment.setTimeout(
      () => {
        this.#pending.delete(key);
        if (!this.#queue.includes(key)) this.#queue.push(key);
        this.#pump();
      },
      Math.max(settle, gap),
    );
    this.#pending.set(key, entry);
  }

  #drop(key: string): void {
    const entry = this.#pending.get(key);
    if (entry !== undefined) this.#environment.clearTimeout(entry.timer);
    this.#pending.delete(key);
    const queued = this.#queue.indexOf(key);
    if (queued !== -1) this.#queue.splice(queued, 1);
    this.#seen.delete(key);
  }

  #pump(): void {
    while (this.#running < this.#limits.concurrency) {
      const key = this.#queue.shift();
      if (key === undefined) return;
      this.#running += 1;
      void this.#read(key).finally(() => {
        this.#running -= 1;
        this.#pump();
      });
    }
  }

  async #read(key: string): Promise<void> {
    const scope = this.#scopes.get(key);
    if (scope === undefined || !this.#allowed() || key === this.#open) return;
    const daemon = this.#input.connections().find(candidate => candidate.daemonId === scope.daemonId);
    const view = this.#input.fleet.getSnapshot().daemons.get(scope.daemonId)?.byId.get(scope.sessionId);
    if (daemon === undefined || view === undefined) return;
    const run = this.#run;
    const generation = this.#input.cache.generation(scope.daemonId);
    const cursor = view.journalSequence;
    const cached = await this.#input.cache.transcript(scope);
    if (transcriptIsCurrent(cached ?? undefined, view)) return;
    this.#lastRead.set(key, this.#environment.now());
    this.#setInFlight(key, true);
    try {
      const log = await this.#input.readLog(daemon, scope.sessionId);
      if (this.#run === run && key !== this.#open)
        this.#input.cache.saveBackgroundTranscript(scope, { log }, cursor, generation);
    } catch (reason) {
      if (refused(reason)) this.#refused.add(key);
      // Anything else (an outage, a timeout) is the connection model's to say; the next change asks again.
      else this.#seen.delete(key);
    } finally {
      this.#setInFlight(key, false);
    }
  }

  #setInFlight(key: string, on: boolean): void {
    const next = new Set(this.#inFlight);
    if (on) next.add(key);
    else next.delete(key);
    this.#inFlight = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
