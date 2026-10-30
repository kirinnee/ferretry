import type { SendEvidence } from '@ferretry/protocol';
import type { ClockPort, SerialExecutor } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import type { SendEvidenceReading, SendEvidenceSource, SendRoster } from './tracker.ts';
import { judgeSends } from './tracking.ts';
import type { SendLedger, SendRecord, SendRepository } from './types.ts';

/**
 * RE-PROVING THE OLD "NOT DELIVERED" ROWS, ONCE.
 *
 * Before the durable queue, a send the transcript reader could not find after its attempts was settled
 * `timed_out` — shown in red as "it never reached the agent" — although it had been TYPED, and the reader
 * was what failed: on 2026-10-30 a ferret's message the lead had read four times was one of them, because
 * Claude recorded it as a paste it lifted an image out of. The repair window only watches a send for three
 * days, and only matches what the reader understood when it looked, so those rows stayed red.
 *
 * This walks every session once, ONE AT A TIME, and reads each recipient's transcript forward from its
 * oldest such row with the same incremental evidence reader the tracker uses — a look reads a bounded
 * amount and keeps its place, so a huge transcript is read across many looks with the event loop free
 * between them. Every look is judged as it comes (presence is proof), and when the reader reaches the end:
 *
 *   * found — `delivered`, journalled as a correction;
 *   * not found — `unaccounted` (`landing_unconfirmed`), the honest word for a typed send nothing proves;
 *   * the transcript could not be read to its end — `unaccounted` (`transcript_unreadable`).
 *
 * Never "never reached": a typed message may have landed. Only a send NOTHING was typed for (`untyped`) is
 * proven absent, and those keep their red. The ledger is only written under the tracker's own per-session
 * lock, re-read there, and only a row still in the state this pass read is changed.
 */

/** What a finished pass changed, for the marker and the boot log. */
export interface SendReproofCounts {
  readonly sessions: number;
  readonly delivered: number;
  readonly unconfirmed: number;
  readonly unreadable: number;
}

/** The record that the pass finished, so a later start does not read every transcript again. */
export interface SendReproofMarker {
  ran(): Promise<boolean>;
  record(at: string, counts: SendReproofCounts): Promise<void>;
}

export interface SendReproofPorts {
  readonly ledger: Pick<SendLedger, 'list' | 'settle'>;
  readonly evidence: SendEvidenceSource;
  readonly repository: Pick<SendRepository, 'journal'>;
  readonly roster: SendRoster;
  /** The tracker's own queue, so a correction never races one of its looks. */
  readonly serial: SerialExecutor;
  readonly clock: ClockPort;
  readonly marker: SendReproofMarker;
  /** Hands the event loop back between two looks at a transcript. */
  readonly pause: () => Promise<void>;
  readonly log?: (line: string) => void;
}

export interface SendReproofSettings {
  readonly matchSlackMs: number;
  /** A ceiling on the looks one transcript gets, so a reader that never finishes cannot hold the pass. */
  readonly maxLooks: number;
}

export const defaultSendReproofSettings: SendReproofSettings = { matchSlackMs: 5_000, maxLooks: 100_000 };

const UNREADABLE: SendEvidenceReading = { readable: false, inputs: [] };

/** A settled claim of absence for a send that WAS typed: the rows this pass exists to re-prove. */
export function isLegacyAbsence(record: SendRecord): boolean {
  return record.fate === 'timed_out' && record.untyped !== true && record.unaccountedReason !== 'session_ended';
}

/** One session's reading: what was found, and whether the reader reached the end. */
interface SessionReading {
  readonly found: ReadonlyMap<string, SendEvidence>;
  readonly finished: boolean;
}

export class LegacySendReproof {
  #stopped = false;

  constructor(
    private readonly ports: SendReproofPorts,
    private readonly settings: SendReproofSettings = defaultSendReproofSettings,
  ) {}

  /** Stops between two looks; the marker is not written, so the next start finishes the job. */
  stop(): void {
    this.#stopped = true;
  }

  /** Runs the pass if it has not run on this daemon home. `undefined` when it had, or was stopped. */
  async run(): Promise<SendReproofCounts | undefined> {
    if (await this.ports.marker.ran()) return undefined;
    let counts: SendReproofCounts = { sessions: 0, delivered: 0, unconfirmed: 0, unreadable: 0 };
    for (const id of this.ports.roster.sessions()) {
      if (this.#stopped) return undefined;
      const changed = await this.#session(id).catch(() => undefined);
      if (changed === undefined) continue;
      counts = {
        sessions: counts.sessions + (changed.delivered + changed.unconfirmed + changed.unreadable > 0 ? 1 : 0),
        delivered: counts.delivered + changed.delivered,
        unconfirmed: counts.unconfirmed + changed.unconfirmed,
        unreadable: counts.unreadable + changed.unreadable,
      };
    }
    if (this.#stopped) return undefined;
    await this.ports.marker.record(this.ports.clock.now(), counts);
    this.ports.log?.(
      `send ledger re-proved — ${counts.delivered} delivered, ${counts.unconfirmed} unconfirmed, ` +
        `${counts.unreadable} unreadable, across ${counts.sessions} session(s)`,
    );
    return counts;
  }

  async #session(id: SessionId): Promise<Omit<SendReproofCounts, 'sessions'> | undefined> {
    const records = await this.ports.ledger.list(id);
    const legacy = records.filter(isLegacyAbsence);
    if (legacy.length === 0) return undefined;
    const reading = await this.#read(id, records, legacy);
    if (reading === undefined) return undefined;
    return await this.ports.serial.run(id, async () => await this.#settle(id, legacy, reading));
  }

  /** Reads the transcript forward from the oldest row, judging every look; `undefined` once stopped. */
  async #read(
    id: SessionId,
    records: readonly SendRecord[],
    legacy: readonly SendRecord[],
  ): Promise<SessionReading | undefined> {
    const oldest = Math.min(...legacy.map(record => Date.parse(record.acceptedAt)));
    const since = new Date(oldest - this.settings.matchSlackMs).toISOString();
    const taken = new Set(records.flatMap(record => (record.evidence === undefined ? [] : [record.evidence.key])));
    const found = new Map<string, SendEvidence>();
    for (let look = 0; look < this.settings.maxLooks; look += 1) {
      if (this.#stopped) return undefined;
      const reading = await this.ports.evidence.read(id, since).catch(() => UNREADABLE);
      const open = legacy.filter(record => !found.has(record.sendId));
      for (const [sendId, verdict] of judgeSends(open, taken, reading.inputs, this.settings.matchSlackMs)) {
        if (verdict.delivered === undefined) continue;
        found.set(sendId, verdict.delivered);
        taken.add(verdict.delivered.key);
      }
      if (found.size === legacy.length) return { found, finished: true };
      if (reading.catchingUp !== true) return { found, finished: reading.readable };
      await this.ports.pause();
    }
    return { found, finished: false };
  }

  async #settle(
    id: SessionId,
    legacy: readonly SendRecord[],
    reading: SessionReading,
  ): Promise<Omit<SendReproofCounts, 'sessions'>> {
    const now = this.ports.clock.now();
    const current = new Map((await this.ports.ledger.list(id)).map(record => [record.sendId, record]));
    let delivered = 0;
    let unconfirmed = 0;
    let unreadable = 0;
    for (const record of legacy) {
      const latest = current.get(record.sendId);
      // Something else settled it while this pass was reading: that word is newer than this one.
      if (latest === undefined || !isLegacyAbsence(latest) || latest.fateAt !== record.fateAt) continue;
      const evidence = reading.found.get(record.sendId);
      if (evidence !== undefined) {
        await this.ports.ledger.settle(id, record.sendId, {
          fate: 'delivered',
          fateAt: now,
          evidence,
          deadlineAt: undefined,
          unaccountedReason: undefined,
          retryable: undefined,
        });
        await this.ports.repository.journal(id, 'control.send_delivered', {
          sendId: record.sendId,
          attempt: record.attempt ?? 1,
          corrected: record.fate,
          reproof: true,
        });
        delivered += 1;
        continue;
      }
      const reason = reading.finished ? 'landing_unconfirmed' : 'transcript_unreadable';
      await this.ports.ledger.settle(id, record.sendId, {
        fate: 'unaccounted',
        fateAt: now,
        unaccountedReason: reason,
        deadlineAt: undefined,
        retryable: undefined,
      });
      await this.ports.repository.journal(id, 'control.send_unaccounted', {
        sendId: record.sendId,
        corrected: record.fate,
        reason,
        reproof: true,
      });
      if (reading.finished) unconfirmed += 1;
      else unreadable += 1;
    }
    return { delivered, unconfirmed, unreadable };
  }
}
