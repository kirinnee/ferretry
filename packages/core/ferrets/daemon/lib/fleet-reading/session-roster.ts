/**
 * EVERY SESSION'S (RUNTIME, TRANSCRIPT), READ ONCE PER CHANGE — NOT ONCE PER LOGIN PER LOOK.
 *
 * A Codex login's passive reading comes from the rollouts of the sessions that ran on its runtimes, so
 * deciding which files to watch needs every session's config. The fleet reading used to read them all on
 * every `passiveUsage` — and the credentials list asks once per login, so a fleet of seven Codex logins
 * and ~600 sessions read, parsed and validated ~4,000 configs per list, several lists a second. That held
 * the main thread.
 *
 * The roster is read once and kept while its stamp holds: the stamp is whatever moves when a session's
 * runtime or transcript can have changed (a config written, a session added or removed). Every caller
 * that asks while it holds — every login of one list, every list after it — shares that one read, and
 * concurrent callers share the read in flight. Each read is a new **generation**, so a reader can skip
 * re-deriving what it derived from the generation it already saw.
 *
 * A STAMP IS NEVER TRUSTED FOREVER. A change no stamp can see — a config edited by hand outside the
 * daemon — is read at the latest {@link SessionRosterPorts.maxAgeMs} after the last read, so correctness
 * never depends on the stamp moving; only how often the roster is read does.
 */
import type { CredentialSessionRecord } from '../fleet/credentials-service.ts';

export interface SessionRosterPorts {
  /** Moves whenever a session's runtime or transcript may have changed. Synchronous and cheap. */
  stamp(): string;
  /** Every session's record: the costly read the roster exists to share. */
  read(): Promise<readonly CredentialSessionRecord[]>;
  now(): number;
  /** The longest a roster is kept without a read, however still its stamp is. */
  readonly maxAgeMs: number;
}

/** One read of the roster, and which read it was. */
export interface SessionRosterSnapshot {
  readonly generation: number;
  readonly sessions: readonly CredentialSessionRecord[];
}

/** What the fleet reading needs of the roster. */
export interface SessionRosterReader {
  current(): Promise<SessionRosterSnapshot>;
}

interface KeptRoster {
  readonly stamp: string;
  readonly at: number;
  readonly snapshot: Promise<SessionRosterSnapshot>;
}

/** How long a roster is kept while its stamp holds, at most. */
export const SESSION_ROSTER_MAX_AGE_MS = 60_000;

export class SessionRoster implements SessionRosterReader {
  #kept: KeptRoster | undefined;
  #generation = 0;

  constructor(private readonly ports: SessionRosterPorts) {}

  /**
   * The roster as of its stamp: the kept read while the stamp holds and it is young enough, a new read
   * otherwise. A read that fails answers no sessions — as the reading always did — and is not kept.
   */
  async current(): Promise<SessionRosterSnapshot> {
    const stamp = this.ports.stamp();
    const now = this.ports.now();
    const kept = this.#kept;
    if (kept !== undefined && kept.stamp === stamp && now - kept.at < this.ports.maxAgeMs) return await kept.snapshot;
    this.#generation += 1;
    const generation = this.#generation;
    const fresh: KeptRoster = {
      stamp,
      at: now,
      snapshot: this.ports.read().then(
        sessions => ({ generation, sessions }),
        () => {
          if (this.#kept === fresh) this.#kept = undefined;
          return { generation, sessions: [] };
        },
      ),
    };
    this.#kept = fresh;
    return await fresh.snapshot;
  }
}
