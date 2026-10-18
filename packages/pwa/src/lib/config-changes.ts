/**
 * WHAT THIS BROWSER KNOWS ABOUT EACH MACHINE'S CONFIGURATION REVISION, and which screens must read again
 * (docs/config-files.md "Live changes").
 *
 * Every screen that shows configuration — the Runtimes and Credentials tabs, the runtime picker, What
 * agents may control, Speed-ups, the Warden and Learning settings, the voice default, the files — read it
 * once and kept it. That is what made a change invisible until the whole app was reloaded: nothing ever
 * told those screens the machine had moved on. The daemon now counts every change, from any source, and
 * says which kinds moved on `/v1/events?topic=config`; this store turns that into one counter per kind,
 * per machine, and a screen re-reads when the counter for a kind it shows moves.
 *
 * THE REVISION IS COMPARED, NOT TRUSTED TO ARRIVE. A stream that was down missed whatever happened, so
 * the first frame of every connection says where the revision stands and this store compares it with
 * the last one it saw: moved, or a different boot, and every kind is read again — because which kinds
 * moved while nobody was listening is exactly what is not known. A gap inside one connection (a frame
 * that skipped a revision) is treated the same way.
 *
 * THE FIRST FRAME EVER IS A BASELINE. A screen that mounted before the stream opened read the
 * configuration as it was then; the stream's first answer is the revision that read already reflects.
 */

import {
  CONFIG_CHANGE_KINDS,
  type ConfigChangeFrame,
  type ConfigChangeKind,
  type ConfigRevision,
  type IFyApiClient,
} from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';

type KindCounters = Readonly<Record<ConfigChangeKind, number>>;

interface MachineRevision {
  readonly seen: ConfigRevision | null;
  readonly counters: KindCounters;
}

const ZERO: KindCounters = Object.freeze(
  Object.fromEntries(CONFIG_CHANGE_KINDS.map(kind => [kind, 0])) as Record<ConfigChangeKind, number>,
);

const UNSEEN: MachineRevision = Object.freeze({ seen: null, counters: ZERO });

/** Which kinds a frame says moved, given the revision last seen. `[]` when nothing did. */
export const kindsToReread = (seen: ConfigRevision | null, frame: ConfigChangeFrame): readonly ConfigChangeKind[] => {
  const named = frame.kind === 'config' ? frame.kinds : [];
  if (seen === null) return named;
  if (seen.epoch !== frame.epoch) return CONFIG_CHANGE_KINDS;
  if (frame.revision <= seen.revision) return [];
  // Exactly the next revision, and it says what moved: only those. Anything else is a revision this
  // browser never heard about, so it cannot say what moved.
  if (named.length > 0 && frame.revision === seen.revision + 1) return named;
  return CONFIG_CHANGE_KINDS;
};

/**
 * One counter per kind per machine, through the external-store contract so a screen reads it
 * synchronously and re-renders only when it moves.
 */
export class DaemonConfigChangeStore {
  readonly #listeners = new Set<() => void>();
  #machines: ReadonlyMap<DaemonId, MachineRevision> = new Map();

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** How many times any of these kinds has moved on this machine. A screen depends on the number. */
  counter(daemonId: DaemonId, kinds: readonly ConfigChangeKind[]): number {
    const counters = (this.#machines.get(daemonId) ?? UNSEEN).counters;
    return kinds.reduce((total, kind) => total + counters[kind], 0);
  }

  /** Fold one frame from this machine's stream in. */
  observe(daemonId: DaemonId, frame: ConfigChangeFrame): void {
    const machine = this.#machines.get(daemonId) ?? UNSEEN;
    const moved = kindsToReread(machine.seen, frame);
    const counters =
      moved.length === 0
        ? machine.counters
        : (Object.fromEntries(
            CONFIG_CHANGE_KINDS.map(kind => [kind, machine.counters[kind] + (moved.includes(kind) ? 1 : 0)]),
          ) as Record<ConfigChangeKind, number>);
    const seen =
      machine.seen === null || machine.seen.epoch !== frame.epoch || frame.revision > machine.seen.revision
        ? { epoch: frame.epoch, revision: frame.revision }
        : machine.seen;
    if (seen === machine.seen && counters === machine.counters) return;
    this.#machines = new Map(this.#machines).set(daemonId, { seen, counters });
    if (moved.length > 0) for (const listener of [...this.#listeners]) listener();
  }
}

// ─── the stream ──────────────────────────────────────────────────────────────────────────────────────

/** How a dropped configuration stream comes back: soon at first, then no faster than this. */
export const CONFIG_STREAM_BACKOFF = { baseMs: 1_000, factor: 2, ceilingMs: 30_000 } as const;

/** No frame at all for this long — three of the daemon's thirty-second idle windows — is a dead socket. */
export const CONFIG_STREAM_SILENCE_MS = 90_000;

export const configStreamDelayMs = (attempt: number, random: number): number => {
  const { baseMs, factor, ceilingMs } = CONFIG_STREAM_BACKOFF;
  const window = Math.min(ceilingMs, baseMs * factor ** Math.max(0, attempt));
  return Math.round(window / 2 + (window / 2) * Math.min(1, Math.max(0, random)));
};

export interface ConfigStreamEnvironment {
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly random: () => number;
}

export interface ConfigStreamInput {
  readonly api: Pick<IFyApiClient, 'configChanges'>;
  readonly environment: ConfigStreamEnvironment;
  readonly onFrame: (frame: ConfigChangeFrame) => void;
}

export interface ConfigStreamControl {
  readonly stop: () => void;
  /** Open it again now: what the app does when it comes back to the foreground or back online. */
  readonly reconnect: () => void;
}

/**
 * Keep one configuration stream open for as long as it is wanted.
 *
 * A dropped stream is reopened after a growing, jittered delay, and a stream that goes silent past
 * {@link CONFIG_STREAM_SILENCE_MS} is treated as dropped. There is no attempt budget: nothing on screen
 * offers a Reconnect for this, and every reopen costs the daemon one frame. Reopening is NOT polling —
 * nothing is read on a schedule while the stream is up; the revision in its first frame is how a reader
 * learns what it missed while it was down.
 */
export const startConfigChangeStream = (input: ConfigStreamInput): ConfigStreamControl => {
  const { environment } = input;
  let generation = 0;
  let attempt = 0;
  let stopped = false;
  let timer: unknown;
  let silence: unknown;
  let abort: AbortController | undefined;

  const clear = (): void => {
    if (timer !== undefined) environment.clearTimeout(timer);
    if (silence !== undefined) environment.clearTimeout(silence);
    timer = undefined;
    silence = undefined;
  };

  const abandon = (): void => {
    generation += 1;
    abort?.abort();
    abort = undefined;
    clear();
  };

  function open(): void {
    generation += 1;
    const mine = generation;
    const controller = new AbortController();
    abort = controller;
    const current = (): boolean => !stopped && mine === generation;
    const ended = (): void => {
      if (!current()) return;
      abandon();
      const delay = configStreamDelayMs(attempt, environment.random());
      attempt += 1;
      const next = generation;
      timer = environment.setTimeout(() => {
        timer = undefined;
        if (!stopped && next === generation) open();
      }, delay);
    };
    const watch = (): void => {
      if (silence !== undefined) environment.clearTimeout(silence);
      silence = environment.setTimeout(() => {
        silence = undefined;
        ended();
      }, CONFIG_STREAM_SILENCE_MS);
    };
    watch();
    void input.api
      .configChanges(frame => {
        if (!current()) return;
        attempt = 0;
        watch();
        input.onFrame(frame);
      }, controller.signal)
      .then(ended, ended);
  }

  open();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      abandon();
    },
    reconnect: () => {
      if (stopped) return;
      abandon();
      attempt = 0;
      open();
    },
  };
};
