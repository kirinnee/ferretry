/**
 * THE CODEX PASSIVE USAGE READING, KEPT CURRENT BY ONE PASS (design §8.2.3; today's `FleetReading` passive watches).
 *
 * A Codex login has no statusLine to report its windows, but every Codex turn writes its `rate_limits` into the session's
 * rollout. This pass reads the newest of them for each Codex login and records it as the login's passive reading, so the
 * login's usage stays fresh with no provider call.
 *
 * - **Which rollout is whose.** Only a rollout of a ferret this daemon launched is read, through the harness's own proof
 *   of that ferret's transcript ({@link PassiveSession.open}); the history pool mixes every login's rollouts, so none of
 *   it is ever read. A ferret belongs to a login by {@link attributedSessions}.
 * - **What replaces today's watches.** Today a file-event hub told the service a rollout changed. Here one kernel job
 *   runs the pass on an interval, and the pass itself is what makes an unchanged rollout cost one stat: a transcript is
 *   read again only when its stamp (token, size, modification time) moved since it was last read.
 * - **Whose reading it is.** A rollout can outlive the login a ferret started on (a same-harness move keeps the
 *   conversation, and a daemon restart rereads it), so a reading is accepted only when it carries its OWN valid event
 *   timestamp (a file's modification time proves nothing) at or after the instant Logins first saw the ferret on its
 *   current login. That instant is Logins' own durable record ({@link PassiveAssignmentsPort}): it moves only when the
 *   login seen for the ferret differs from the recorded one, never on a working/idle change of the ferret.
 * - **A move during a read.** The ferret's login is asked again after its transcript was read
 *   ({@link PassiveSession.current}); a reading read across a move is dropped and tried again next pass.
 * - **Never wrong, only late.** A reading is recorded only when it is newer than the one this pass last recorded, and a
 *   read that fails or is dropped leaves its stamp unrecorded so the next pass tries it again. A login that cannot be
 *   read does not stop the others.
 */
import type { CredentialEntry } from './credentials-service.ts';
import type { CredentialSubject } from './credential-status.ts';
import { newestRolloutReading, type RolloutBytes } from './rollout-reading.ts';
import type { PassiveUsageRecord } from './usage.ts';

/** One transcript a harness proved to be a ferret's: opened once, read in windows, then closed. */
export interface PassiveTranscript extends RolloutBytes {
  /** Opaque: changes when the file is replaced. */
  readonly file: string;
  close(): Promise<void>;
}

/** One ferret this daemon launched on a Codex runtime. */
export interface PassiveSession {
  readonly id: string;
  /** The runtime it was started on. */
  readonly runtime?: string;
  /** The login it was started on, when its record names one. */
  readonly login?: string;
  /**
   * The ferret's record's `stateAt` now (epoch ms; not a number when it has none). Every launch sets it, but a working
   * or idle change moves it too, so it is only what a login's `since` is first taken from ({@link PassiveAssignmentsPort}).
   */
  readonly stateAt: number;
  /**
   * The ferret's runtime and login as they are NOW, asked again after its transcript was read; `undefined` when it is
   * gone or stopped. A reading is dropped when this no longer names the login it was listed on.
   */
  current(): Promise<Pick<PassiveSession, 'login' | 'runtime'> | undefined>;
  /** Its proved transcript, or `undefined` while none is proved. */
  open(): Promise<PassiveTranscript | undefined>;
}

/** One Codex login the pass keeps current. */
export interface PassiveLogin {
  readonly subject: CredentialSubject;
  readonly usedBy: CredentialEntry['usedBy'];
}

/** Logins' own durable record of which login each ferret was last seen on, and since when (epoch ms). */
export interface PassiveAssignmentsPort {
  read(): Promise<Readonly<Record<string, PassiveAssignment>>>;
  write(assignments: Readonly<Record<string, PassiveAssignment>>): Promise<void>;
}

export interface PassiveAssignment {
  /** The login Logins saw the ferret on (a login id, or `runtime:<name>` for a ferret naming none). */
  readonly login: string;
  /** The ferret's `stateAt` at the moment Logins first saw it on that login (now, when it had none). */
  readonly since: number;
}

export interface CodexPassivePorts {
  /** Which login each ferret was last seen on, and since when. */
  readonly assignments: PassiveAssignmentsPort;
  /** The current instant, epoch ms. */
  now(): number;
  /** The Codex logins whose sign-in this daemon owns. */
  logins(): Promise<readonly PassiveLogin[]>;
  /** The live ferrets launched on Codex. */
  sessions(): Promise<readonly PassiveSession[]>;
  /** Records a login's passive reading (replacing the one before it). */
  write(subject: CredentialSubject, record: PassiveUsageRecord): Promise<void>;
}

/**
 * The sessions that ran on this login (§8.2.3): the one it was started on, by the login its record names or, when it
 * names none, by a runtime that uses the login. A ferret this daemon did not launch is not in the list, so it is never
 * attributed: the shared pool mixes logins.
 */
export function attributedSessions<Session extends Pick<PassiveSession, 'login' | 'runtime'>>(
  entry: Pick<CredentialEntry, 'id' | 'usedBy'>,
  sessions: readonly Session[],
): readonly Session[] {
  return sessions.filter(session =>
    session.login === undefined
      ? session.runtime !== undefined && entry.usedBy.includes(session.runtime)
      : session.login === entry.id,
  );
}

/** The login a ferret is on, as Logins sees it: its login, or the runtime it names when it names none. */
const seenOn = (who: Pick<PassiveSession, 'login' | 'runtime'>): string | undefined =>
  who.login ?? (who.runtime === undefined ? undefined : `runtime:${who.runtime}`);

const stampOf = (transcript: PassiveTranscript): string =>
  `${transcript.file}:${String(transcript.size)}:${String(transcript.mtimeMs)}`;

export class CodexPassiveReading {
  /** Each ferret's transcript stamp as last read, so an unchanged one is not read again. */
  readonly #read = new Map<string, string>();
  /** The instant of the reading last recorded for each login. */
  readonly #recorded = new Map<string, number>();
  /** The assignments as held (read from the record once, then kept) and as last written to it. */
  #assignments: Readonly<Record<string, PassiveAssignment>> | undefined;
  #persisted = '';

  constructor(private readonly ports: CodexPassivePorts) {}

  /** One pass: read each changed rollout of each Codex login, and record the newest reading it found. */
  async pass(): Promise<void> {
    const logins = await this.ports.logins();
    if (logins.length === 0) return;
    const sessions = await this.ports.sessions();
    const live = new Set(sessions.map(session => session.id));
    for (const id of this.#read.keys()) if (!live.has(id)) this.#read.delete(id);
    const assignments = await this.#assigned(sessions);
    for (const login of logins) {
      try {
        await this.#login(
          login,
          attributedSessions({ id: login.subject.id, usedBy: login.usedBy }, sessions),
          assignments,
        );
      } catch {
        // One login that cannot be read or recorded is tried again next pass and never stops the others.
      }
    }
  }

  /**
   * What each live ferret's assignment is now. A ferret keeps its recorded `since` for as long as the login seen for it
   * is the recorded one; a different login starts a new one at the ferret's `stateAt` (now when it has none). A
   * ferret gone from the list is forgotten. The record is written only when it changed, and a write that failed is
   * tried again next pass.
   */
  async #assigned(sessions: readonly PassiveSession[]): Promise<Readonly<Record<string, PassiveAssignment>>> {
    if (this.#assignments === undefined) {
      this.#assignments = await this.ports.assignments.read();
      this.#persisted = JSON.stringify(this.#assignments);
    }
    const held = this.#assignments;
    const next: Record<string, PassiveAssignment> = {};
    for (const session of sessions) {
      const login = seenOn(session);
      if (login === undefined) continue;
      const before = held[session.id];
      next[session.id] =
        before?.login === login
          ? before
          : { login, since: Number.isFinite(session.stateAt) ? Math.trunc(session.stateAt) : this.ports.now() };
    }
    this.#assignments = next;
    const text = JSON.stringify(next);
    if (text !== this.#persisted) {
      try {
        await this.ports.assignments.write(next);
        this.#persisted = text;
      } catch {
        // Kept in memory; the next pass writes it again.
      }
    }
    return next;
  }

  async #login(
    login: PassiveLogin,
    sessions: readonly PassiveSession[],
    assignments: Readonly<Record<string, PassiveAssignment>>,
  ): Promise<void> {
    const seen = new Map<string, string>();
    let newest: PassiveUsageRecord | undefined;
    for (const session of sessions) {
      const since = assignments[session.id]?.since;
      if (since === undefined) continue;
      const reading = await this.#session(session, since, seen);
      if (reading !== undefined && (newest === undefined || reading.at > newest.at)) newest = reading;
    }
    if (newest !== undefined && newest.at > (this.#recorded.get(login.subject.id) ?? Number.NEGATIVE_INFINITY)) {
      await this.ports.write(login.subject, newest);
      this.#recorded.set(login.subject.id, newest.at);
    }
    for (const [id, stamp] of seen) this.#read.set(id, stamp);
  }

  /** One ferret's newest reading, or `undefined` when its transcript is unproved, unchanged or unreadable. */
  async #session(
    session: PassiveSession,
    since: number,
    seen: Map<string, string>,
  ): Promise<PassiveUsageRecord | undefined> {
    const transcript = await session.open().catch(() => undefined);
    if (transcript === undefined) return undefined;
    try {
      // The stamp stands for the file AND the attribution it was judged under, so a ferret that moved is read afresh.
      const stamp = `${stampOf(transcript)}|${seenOn(session) ?? ''}|${String(since)}`;
      if (this.#read.get(session.id) === stamp) return undefined;
      const reading = await newestRolloutReading(transcript);
      // A move between the listing and now: whatever was read may be the new login's, so it is dropped and read again.
      const now = await session.current();
      if (now === undefined || seenOn(now) !== seenOn(session)) return undefined;
      seen.set(session.id, stamp);
      return reading !== undefined && reading.at >= since ? reading : undefined;
    } catch {
      return undefined;
    } finally {
      await transcript.close().catch(() => undefined);
    }
  }
}
