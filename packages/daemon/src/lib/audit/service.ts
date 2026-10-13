import { auditShortId, type PushDeliveryResult, type PushDeviceView } from '@ferretry/protocol';
import type { PushDispatch } from '../push/types.ts';
import { auditFoldKey, auditRecord, isKeptAuditEntry, newDeviceAlert, withinAuditBounds } from './policy.ts';
import type {
  AuditClock,
  AuditEntry,
  AuditFailureReporter,
  AuditJournalPort,
  AuditReading,
  AuditSink,
  NewDeviceAlertPort,
  PairedDeviceNotice,
} from './types.ts';

/**
 * How long repeats of one refusal, or one terminal's keystrokes, are folded into a single count.
 *
 * A minute: short enough that a reader sees "it kept happening" close to when it did, long enough that
 * a flood writes one line a minute per actor rather than one per request.
 */
export const AUDIT_FOLD_WINDOW_MS = 60_000;

/**
 * At most this many windows are open at once. A full table closes every window first, so the memory a
 * flood can make this hold is bounded too — not only the file.
 */
export const AUDIT_MAX_OPEN_FOLDS = 1_024;

interface AuditFold {
  readonly startedMs: number;
  repeats: number;
  readonly entry: AuditEntry;
}

export interface AuditLogOptions {
  readonly journal: AuditJournalPort;
  readonly clock: AuditClock;
  readonly failures: AuditFailureReporter;
}

/**
 * The one writer and reader of this daemon's security log.
 *
 * ## A RECORD THAT CANNOT BE WRITTEN IS SAID OUT LOUD, NEVER THROWN
 *
 * Every record describes something that has ALREADY happened — a device is paired, a phone is
 * revoked. Throwing a failed write back into that request would report a revocation that worked as
 * one that did not, and a person would try again against a phone that is already gone. So `record`
 * resolves either way, and a failure goes to the operator through {@link AuditFailureReporter}:
 * the log is incomplete, and the person who owns the machine is told so, which is the opposite of
 * the silent hole an unreported failure would leave.
 *
 * A record that does not fit the contract is the same kind of failure — an emitter bug — and is
 * reported the same way rather than written as a line the reader would have to count as damage.
 */
export class AuditLog implements AuditSink {
  readonly #folds = new Map<string, AuditFold>();

  constructor(private readonly options: AuditLogOptions) {}

  /**
   * Writes one record — or, for a REPEAT, counts it.
   *
   * ## REPEATS ARE FOLDED, SO A FLOOD COSTS ONE LINE A MINUTE
   *
   * A refused or failed record, and every input record, opens a window of {@link AUDIT_FOLD_WINDOW_MS}
   * keyed by who did it, what they did and how it ended (see `auditFoldKey`). The first is written;
   * the rest inside the window are only counted, and the count is written as ONE record — the first
   * one's event with `detail.repeats` — when the window closes. So "somebody kept trying" survives as
   * a fact with a number on it, and a device hammering a refused route cannot write its way through
   * the file's bound. Successes of everything else are never folded: each is a distinct act.
   */
  async record(entry: AuditEntry): Promise<void> {
    const at = this.options.clock.now();
    const key = auditFoldKey(entry);
    if (key !== undefined) {
      const atMs = Date.parse(at);
      const open = this.#folds.get(key);
      if (open !== undefined && atMs - open.startedMs < AUDIT_FOLD_WINDOW_MS) {
        open.repeats += 1;
        return;
      }
      if (open !== undefined) await this.#close(key, open, at);
      if (this.#folds.size >= AUDIT_MAX_OPEN_FOLDS) await this.flush(Number.POSITIVE_INFINITY);
      this.#folds.set(key, { startedMs: atMs, repeats: 0, entry });
    }
    await this.#write(entry, at);
  }

  /**
   * Closes every window that has run its length, writing each one's count.
   *
   * The composition root calls this on a timer, so a burst that STOPS is still reported: a window is
   * otherwise closed only by the next record like it, which an attacker who went quiet never sends.
   * `nowMs` is a parameter so a caller can close every window at once — at shutdown, or when the
   * table of open windows is full.
   */
  async flush(nowMs: number = Date.parse(this.options.clock.now())): Promise<void> {
    for (const [key, open] of [...this.#folds]) {
      if (nowMs - open.startedMs < AUDIT_FOLD_WINDOW_MS) continue;
      await this.#close(key, open, this.options.clock.now());
    }
  }

  async #close(key: string, open: AuditFold, at: string): Promise<void> {
    this.#folds.delete(key);
    if (open.repeats === 0) return;
    // The repeats may have named different subjects — a flood of random ids — so the summary names
    // none unless the subject is part of what was folded (an input record's terminal).
    const { subject, ...rest } = open.entry;
    const keepsSubject = open.entry.event.endsWith('.input');
    await this.#write(
      {
        ...rest,
        ...(keepsSubject && subject !== undefined ? { subject } : {}),
        detail: { ...open.entry.detail, repeats: open.repeats },
      },
      at,
    );
  }

  async #write(entry: AuditEntry, at: string): Promise<void> {
    try {
      const line = JSON.stringify(auditRecord(withinAuditBounds(entry), at));
      await this.options.journal.append(line, isKeptAuditEntry(entry) ? 'kept' : 'general');
    } catch (error) {
      this.options.failures.auditWriteFailed(
        `the security log could not record a ${entry.event} event, so it has a gap: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The most recent records, newest first, with the count of lines that could not be read. */
  async recent(limit: number): Promise<AuditReading> {
    return await this.options.journal.recent(limit);
  }
}

/** The two things the alert needs from the push domain, and nothing that could reach a key. */
export interface NewDeviceAlertPush {
  list(): Promise<readonly PushDeviceView[]>;
  notify(dispatch: PushDispatch, to?: readonly string[]): Promise<PushDeliveryResult>;
}

/**
 * "A new device was paired" — pushed to every enrolment that already existed.
 *
 * EVERY OTHER DEVICE, BY CONSTRUCTION. An enrolment is filed against a device grant, and the device
 * that was just paired has not enrolled yet — it cannot have: its grant is seconds old and enrolling
 * takes the browser's own permission prompt. The enrolments listed here are therefore exactly the
 * devices that were paired BEFORE it, and the addressed list is taken before anything is sent so a
 * concurrent enrolment cannot slip in.
 *
 * A DELIVERY THAT FAILS DOES NOT UNDO THE PAIRING. The alert is a warning about something that has
 * already happened; the app's own in-app notice is the second channel that carries the same news.
 */
export class PushNewDeviceAlert implements NewDeviceAlertPort {
  constructor(
    private readonly push: NewDeviceAlertPush,
    private readonly machineName: string,
    private readonly failures: AuditFailureReporter,
  ) {}

  async newDevicePaired(device: PairedDeviceNotice): Promise<void> {
    try {
      const addressed = (await this.push.list()).map(enrolment => enrolment.id);
      if (addressed.length === 0) return;
      await this.push.notify({ payload: newDeviceAlert(device, this.machineName) }, addressed);
    } catch (error) {
      this.failures.auditWriteFailed(
        `the other devices could not be told that device ${auditShortId(device.deviceId)} was paired: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
