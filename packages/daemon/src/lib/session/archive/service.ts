import { ARCHIVE_AFTER_MS_DEFAULT, ARCHIVE_PASS_LIMIT_DEFAULT, type ArchiveSession, decideArchive } from './policy.ts';

/** What one pass did. */
export interface ArchivePassResult {
  /** Sessions that left the live set this pass. */
  readonly archived: number;
  /** Sessions that qualify but wait for the next pass (the per-pass bound). */
  readonly deferred: number;
  /** Sessions still live after the pass. */
  readonly live: number;
}

export interface SessionArchivePorts {
  readonly clock: { nowMs(): number };
  /**
   * Every live session, as the rule reads it. The adapter reads them PACED and out of the cache, and leaves out a
   * session whose documents it cannot read — an unreadable session is kept.
   */
  sessions(): Promise<readonly ArchiveSession[]>;
  /**
   * Which of these sessions something outside them keeps live (a pin, a card in flight, an open agenda item), with
   * why. Asked only about sessions that already qualify by age and kind, so the reads it costs are the few that
   * matter. A session it cannot answer for is named as kept.
   */
  kept(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * Takes these sessions out of the live set. Answers how many left. `roster` is what the decision was made from: the
   * adapter checks the lineage and the keep signals AGAIN at the commit boundary, with the sessions' lanes held,
   * because the roster is only a snapshot.
   */
  archive(ids: readonly string[], roster: readonly ArchiveSession[]): Promise<number>;
}

export interface SessionArchiveSettings {
  readonly afterMs: number;
  readonly passLimit: number;
}

export const SESSION_ARCHIVE_SETTINGS_DEFAULT: SessionArchiveSettings = {
  afterMs: ARCHIVE_AFTER_MS_DEFAULT,
  passLimit: ARCHIVE_PASS_LIMIT_DEFAULT,
};

/**
 * Takes finished autonomous sessions out of the live set (docs/session-archive.md).
 *
 * TWO LOOKS. The first applies the rule with nothing kept, which is a pure computation over what the adapter already
 * holds and names every session that qualifies by kind and age. Only those are asked about their keep signals, and
 * the rule is applied again with the answers — so a fleet of two thousand finished sessions costs one paced read of
 * their documents and one question about the few that qualify, never a question about every session.
 *
 * ONE PASS AT A TIME. A pass that is still running makes the next request a no-op rather than a second walk.
 */
export class SessionArchiveService {
  private running = false;

  constructor(
    private readonly ports: SessionArchivePorts,
    private readonly settings: SessionArchiveSettings = SESSION_ARCHIVE_SETTINGS_DEFAULT,
  ) {}

  /** One pass; `undefined` when one is already running. */
  async runPass(): Promise<ArchivePassResult | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      const sessions = await this.ports.sessions();
      const nowMs = this.ports.clock.nowMs();
      const base = { nowMs, afterMs: this.settings.afterMs };
      const qualifying = decideArchive(sessions, {
        ...base,
        kept: new Map(),
        limit: Number.POSITIVE_INFINITY,
      }).archive;
      if (qualifying.length === 0) return { archived: 0, deferred: 0, live: sessions.length };
      const kept = await this.ports.kept(qualifying);
      const decision = decideArchive(sessions, { ...base, kept, limit: this.settings.passLimit });
      const archived = decision.archive.length === 0 ? 0 : await this.ports.archive(decision.archive, sessions);
      return { archived, deferred: decision.deferred, live: sessions.length - archived };
    } finally {
      this.running = false;
    }
  }
}
