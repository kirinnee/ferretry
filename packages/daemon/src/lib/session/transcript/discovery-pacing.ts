/**
 * How often an unresolved Codex session may look for its rollout.
 *
 * THIS IS THE STORM A REAL FLEET HIT. A session whose rollout is not attributed yet is discovered on
 * EVERY transcript read — the turn watcher every couple of seconds, a declared wait, every session
 * listing, every liveness pass — and each discovery walks the whole Codex home. A session that never
 * resolves (a Codex start that never wrote a rollout, a login it is still waiting at) kept doing that
 * for as long as it lived: on the owner-scale fixture, two such sessions were the largest single
 * source of file system calls the idle daemon made.
 *
 * THE POLICY, in two phases per session:
 *
 *   * EAGER for the first {@link CODEX_DISCOVERY_EAGER_MS} after the SESSION STARTED: every read
 *     discovers, exactly as before, because a Codex rollout appears within seconds of its start and a
 *     reader is waiting to see it.
 *   * PACED after that: at most one discovery every {@link CODEX_DISCOVERY_INTERVAL_MS}. A read in
 *     between answers "not yet" without touching the disk — the same answer the walk would have
 *     given.
 *
 * A change to the home's listing — a new rollout or a new dated directory, whoever's walk or watcher
 * noticed it — re-opens the eager window, because that is the event a waiting session's rollout
 * arrives as.
 *
 * WHY THE SESSION'S START AND NOT THE DAEMON'S FIRST LOOK. Measured from the first look, every daemon
 * restart re-opened two minutes of full walks for every unresolved session, however long ago it
 * started — on the owner-scale fixture, ~1,200 rollout `stat`s a second for exactly the minutes after a
 * boot that are already the busiest. A session started longer ago than the window has had its chance
 * to write a rollout; it is looked for once on the first read and then paced. Only a session whose start
 * is not known falls back to the first look.
 *
 * Callers asking for the same session at once share ONE discovery rather than each walking the home.
 * A discovery that resolves forgets its session: a resolved record never asks again.
 */

import type { TranscriptProvenance } from '@ferretry/protocol';

/** How long, after the session started or the last listing change, every read may discover. */
export const CODEX_DISCOVERY_EAGER_MS = 2 * 60 * 1_000;
/** The least time between two discoveries for one session once the eager window has closed. */
export const CODEX_DISCOVERY_INTERVAL_MS = 30 * 1_000;

/** A clock the pacer reads instants from. */
export interface DiscoveryPacerClock {
  now(): string;
}

/** The two windows, overridable so a test can say them small. */
export interface DiscoveryPacing {
  readonly eagerMs: number;
  readonly intervalMs: number;
}

interface Pace {
  /** Which provenance this pace is for, so a relaunch that recorded a new one starts afresh. */
  readonly key: string;
  /** When the current eager window opened. */
  readonly since: number;
  /** When the last discovery started. */
  readonly last: number | undefined;
  /** The home's change count after the last discovery, to notice a change since. */
  readonly changes: number | undefined;
}

export class CodexDiscoveryPacer {
  readonly #paces = new Map<string, Pace>();
  readonly #running = new Map<string, Promise<TranscriptProvenance | undefined>>();

  constructor(
    private readonly clock: DiscoveryPacerClock,
    private readonly pacing: DiscoveryPacing = {
      eagerMs: CODEX_DISCOVERY_EAGER_MS,
      intervalMs: CODEX_DISCOVERY_INTERVAL_MS,
    },
  ) {}

  /**
   * `discover`'s answer when this session is due to look, the in-flight answer when it is already
   * looking, and `undefined` — "not found yet" — when it looked too recently.
   *
   * `changes` reads the home's listing-change count; without it only the clock decides. `startedAt`
   * reads when the session started, asked once per new pace; without an answer the window opens at
   * this first look.
   */
  async pace(
    sessionId: string,
    provenance: TranscriptProvenance,
    changes: (() => number) | undefined,
    discover: () => Promise<TranscriptProvenance | undefined>,
    startedAt?: () => Promise<string | undefined>,
  ): Promise<TranscriptProvenance | undefined> {
    const running = this.#running.get(sessionId);
    if (running !== undefined) return await running;
    const now = Date.parse(this.clock.now());
    const key = `${provenance.home}\n${provenance.correlationToken ?? ''}\n${String(provenance.baseline?.length ?? 0)}`;
    let known = this.#paces.get(sessionId);
    if (known?.key !== key) {
      const since = startedAt === undefined ? now : await this.since(startedAt, now);
      // The start was read asynchronously, so another reader may have begun looking meanwhile.
      const raced = this.#running.get(sessionId);
      if (raced !== undefined) return await raced;
      known = this.#paces.get(sessionId);
      if (known?.key !== key) known = { key, since, last: undefined, changes: undefined };
    }
    let pace: Pace = known;
    if (pace.changes !== undefined && changes !== undefined && changes() !== pace.changes)
      pace = { ...pace, since: now };
    if (!this.due(pace, now)) {
      this.#paces.set(sessionId, pace);
      return undefined;
    }
    const started = pace;
    const attempt = discover().finally(() => this.#running.delete(sessionId));
    this.#running.set(sessionId, attempt);
    this.#paces.set(sessionId, { ...started, last: now });
    const resolved = await attempt;
    if (resolved !== undefined) this.#paces.delete(sessionId);
    else this.#paces.set(sessionId, { ...started, last: now, changes: changes?.() });
    return resolved;
  }

  /** When a new pace's eager window opened: the session's start, never later than now, or now. */
  private async since(startedAt: () => Promise<string | undefined>, now: number): Promise<number> {
    const started = Date.parse((await startedAt().catch(() => undefined)) ?? '');
    return Number.isFinite(started) ? Math.min(started, now) : now;
  }

  private due(pace: Pace, now: number): boolean {
    if (pace.last === undefined || now < pace.last) return true;
    return now - pace.since < this.pacing.eagerMs || now - pace.last >= this.pacing.intervalMs;
  }
}
