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
 *   conversation, and a daemon restart rereads it), so a reading is accepted only when it was taken at or after the
 *   instant the ferret started on its current login ({@link PassiveSession.since}); an older one is ignored.
 * - **Never wrong, only late.** A reading is recorded only when it is newer than the one this pass last recorded, and a
 *   read that fails leaves its stamp unrecorded so the next pass tries it again. A login that cannot be read does not
 *   stop the others.
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
   * The instant (epoch ms) this ferret last started on its CURRENT login: its record's `stateAt`, which every launch
   * (start, resume, restart, move, revive) sets and nothing earlier can precede. A reading older than it was written
   * before the ferret was on this login, so it is never this login's (a move carries the conversation, and its
   * rollout, to the new login).
   */
  readonly since: number;
  /** Its proved transcript, or `undefined` while none is proved. */
  open(): Promise<PassiveTranscript | undefined>;
}

/** One Codex login the pass keeps current. */
export interface PassiveLogin {
  readonly subject: CredentialSubject;
  readonly usedBy: CredentialEntry['usedBy'];
}

export interface CodexPassivePorts {
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

const stampOf = (transcript: PassiveTranscript): string =>
  `${transcript.file}:${String(transcript.size)}:${String(transcript.mtimeMs)}`;

export class CodexPassiveReading {
  /** Each ferret's transcript stamp as last read, so an unchanged one is not read again. */
  readonly #read = new Map<string, string>();
  /** The instant of the reading last recorded for each login. */
  readonly #recorded = new Map<string, number>();

  constructor(private readonly ports: CodexPassivePorts) {}

  /** One pass: read each changed rollout of each Codex login, and record the newest reading it found. */
  async pass(): Promise<void> {
    const logins = await this.ports.logins();
    if (logins.length === 0) return;
    const sessions = await this.ports.sessions();
    const live = new Set(sessions.map(session => session.id));
    for (const id of this.#read.keys()) if (!live.has(id)) this.#read.delete(id);
    for (const login of logins) {
      try {
        await this.#login(login, attributedSessions({ id: login.subject.id, usedBy: login.usedBy }, sessions));
      } catch {
        // One login that cannot be read or recorded is tried again next pass and never stops the others.
      }
    }
  }

  async #login(login: PassiveLogin, sessions: readonly PassiveSession[]): Promise<void> {
    const seen = new Map<string, string>();
    let newest: PassiveUsageRecord | undefined;
    for (const session of sessions) {
      const reading = await this.#session(session, seen);
      if (reading !== undefined && (newest === undefined || reading.at > newest.at)) newest = reading;
    }
    if (newest !== undefined && newest.at > (this.#recorded.get(login.subject.id) ?? Number.NEGATIVE_INFINITY)) {
      await this.ports.write(login.subject, newest);
      this.#recorded.set(login.subject.id, newest.at);
    }
    for (const [id, stamp] of seen) this.#read.set(id, stamp);
  }

  /** One ferret's newest reading, or `undefined` when its transcript is unproved, unchanged or unreadable. */
  async #session(session: PassiveSession, seen: Map<string, string>): Promise<PassiveUsageRecord | undefined> {
    const transcript = await session.open().catch(() => undefined);
    if (transcript === undefined) return undefined;
    try {
      const stamp = stampOf(transcript);
      if (this.#read.get(session.id) === stamp) return undefined;
      const reading = await newestRolloutReading(transcript);
      seen.set(session.id, stamp);
      return reading !== undefined && reading.at >= session.since ? reading : undefined;
    } catch {
      return undefined;
    } finally {
      await transcript.close().catch(() => undefined);
    }
  }
}
