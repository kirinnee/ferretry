import { auditShortId, type PushDeliveryResult, type PushDeviceView } from '@ferretry/protocol';
import type { PushDispatch } from '../push/types.ts';
import { AUDIT_KEPT_DAILY_ALLOWANCE, auditFoldKey, auditRecord, newDeviceAlert, withinAuditBounds } from './policy.ts';
import type {
  AuditClock,
  AuditEntry,
  AuditFailureReporter,
  AuditJournalPort,
  AuditReading,
  AuditSink,
  AuditStore,
  NewDeviceAlertPort,
  PairedDeviceNotice,
} from './types.ts';

/**
 * How long repeats of one refusal, or of one act of activity, are folded into a single count.
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

const DAY_MS = 86_400_000;

/** The kept records written today by callers who are not this machine — see `AUDIT_KEPT_DAILY_ALLOWANCE`. */
interface KeptAllowance {
  day: number;
  spent: number;
}

/** One kind of kept record past today's allowance: the first is kept and marked, the rest are counted. */
interface Overspent {
  readonly day: number;
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
  readonly #allowance: KeptAllowance = { day: Number.NaN, spent: 0 };
  /** Keyed by event and actor kind, so it holds at most one entry per kept event per kind. */
  readonly #overspent = new Map<string, Overspent>();

  constructor(private readonly options: AuditLogOptions) {}

  /**
   * Writes one record — or, for a REPEAT, counts it.
   *
   * ## REPEATS ARE FOLDED, SO A FLOOD COSTS ONE LINE A MINUTE
   *
   * A refusal, a failure, and every act of activity (anything that is not a kept event) opens a window
   * of {@link AUDIT_FOLD_WINDOW_MS} keyed as `auditFoldKey` says. The first is written to the general
   * store; the rest inside the window are only counted, and the count is written as ONE record — the
   * first one's event with `detail.repeats` — when the window closes. So "somebody kept trying" and
   * "this phone kept attaching" survive as facts with a number on them, and neither can write its way
   * through the file's bound.
   *
   * ## A KEPT EVENT IS NEVER FOLDED, AND IS RATIONED FOR EVERYBODY BUT THE HOST
   *
   * Each pairing, revocation or grant change is its own fact and goes to the kept store — within
   * `AUDIT_KEPT_DAILY_ALLOWANCE` for callers who are not this machine. Past it, see `#overspend`.
   */
  async record(entry: AuditEntry): Promise<void> {
    const at = this.options.clock.now();
    const key = auditFoldKey(entry);
    if (key === undefined) {
      await this.#keep(entry, at);
      return;
    }
    const atMs = Date.parse(at);
    const open = this.#folds.get(key);
    if (open !== undefined && atMs - open.startedMs < AUDIT_FOLD_WINDOW_MS) {
      open.repeats += 1;
      return;
    }
    if (open !== undefined) await this.#close(key, open, at);
    if (this.#folds.size >= AUDIT_MAX_OPEN_FOLDS) await this.#closeFolds(Number.POSITIVE_INFINITY);
    this.#folds.set(key, { startedMs: atMs, repeats: 0, entry });
    await this.#write(entry, at, 'general');
  }

  /**
   * A kept event: to the kept store, unless a caller who is not this machine has spent today's allowance.
   *
   * The allowance is ONE count for every such caller, because a device can pair new devices and each
   * would bring an allowance of its own.
   */
  async #keep(entry: AuditEntry, at: string): Promise<void> {
    if (entry.actor.kind === 'host') {
      await this.#write(entry, at, 'kept');
      return;
    }
    const day = Math.floor(Date.parse(at) / DAY_MS);
    if (this.#allowance.day !== day) {
      this.#allowance.day = day;
      this.#allowance.spent = 0;
    }
    this.#allowance.spent += 1;
    if (this.#allowance.spent <= AUDIT_KEPT_DAILY_ALLOWANCE) {
      await this.#write(entry, at, 'kept');
      return;
    }
    await this.#overspend(entry, at, day);
  }

  /**
   * A kept record past today's allowance.
   *
   * IT STILL LEAVES A MARK THE FLOOD CANNOT REACH. The first of each event and actor kind past the
   * allowance is written to the kept store with `detail.keptAllowanceSpent`, and how many more of it
   * followed that day is written there as one counted record when the day ends. There are only so many
   * kept events and actor kinds, so this is a fixed number of lines a day whoever is flooding. Every
   * overspent record is ALSO written in full to the general store, where it is ordinary history.
   */
  async #overspend(entry: AuditEntry, at: string, day: number): Promise<void> {
    const key = `${entry.event}|${entry.actor.kind}`;
    const open = this.#overspent.get(key);
    await this.#write(entry, at, 'general');
    if (open !== undefined && open.day === day) {
      open.repeats += 1;
      return;
    }
    if (open !== undefined) await this.#closeOverspent(key, open, at);
    this.#overspent.set(key, { day, repeats: 0, entry });
    await this.#write({ ...entry, detail: { ...entry.detail, keptAllowanceSpent: true } }, at, 'kept');
  }

  async #closeOverspent(key: string, open: Overspent, at: string): Promise<void> {
    this.#overspent.delete(key);
    if (open.repeats === 0) return;
    // The repeats were made by different callers to different subjects, so the count names neither.
    await this.#write(
      {
        event: open.entry.event,
        actor: { kind: open.entry.actor.kind },
        outcome: open.entry.outcome,
        detail: { keptAllowanceSpent: true, repeats: open.repeats },
      },
      at,
      'kept',
    );
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
    await this.#closeFolds(nowMs);
    const day = Math.floor(nowMs / DAY_MS);
    for (const [key, open] of [...this.#overspent])
      if (open.day < day) await this.#closeOverspent(key, open, this.options.clock.now());
  }

  /**
   * Closes the fold windows that have run their length. A full table closes them all — but never the
   * overspent counts, which are not in it: closing those early would let anybody who can fill the
   * table make the kept store take another line.
   */
  async #closeFolds(nowMs: number): Promise<void> {
    for (const [key, open] of [...this.#folds]) {
      if (nowMs - open.startedMs < AUDIT_FOLD_WINDOW_MS) continue;
      await this.#close(key, open, this.options.clock.now());
    }
  }

  async #close(key: string, open: AuditFold, at: string): Promise<void> {
    this.#folds.delete(key);
    if (open.repeats === 0) return;
    // A refusal's repeats may have named different subjects — a flood of random ids — so its summary
    // names none. A success folds per subject (see `auditFoldKey`), so its summary keeps it.
    const { subject, ...rest } = open.entry;
    const keepsSubject = open.entry.outcome === 'succeeded';
    await this.#write(
      {
        ...rest,
        ...(keepsSubject && subject !== undefined ? { subject } : {}),
        detail: { ...open.entry.detail, repeats: open.repeats },
      },
      at,
      'general',
    );
  }

  /**
   * One line into one store.
   *
   * A kept line from anybody but this machine is written `never`-rotating: when the kept store is full
   * it is refused rather than renaming the oldest kept file away, and goes to the general store with
   * the operator told. So the kept store's bound is reached only by months of history, and even then
   * nothing a device does can take a kept record off the disk.
   */
  async #write(entry: AuditEntry, at: string, store: AuditStore): Promise<void> {
    try {
      const line = JSON.stringify(auditRecord(withinAuditBounds(entry), at));
      const fromHere = entry.actor.kind === 'host' || store === 'general';
      if (await this.options.journal.append(line, store, fromHere ? 'rotate' : 'never')) return;
      this.options.failures.auditWriteFailed(
        `the security log's kept store is full, so a ${entry.event} event from somebody who is not this machine was written to the ordinary history instead, where newer activity can rotate it away; this machine's own next kept record makes room`,
      );
      await this.options.journal.append(line, 'general');
    } catch (error) {
      this.options.failures.auditWriteFailed(
        `the security log could not record a ${entry.event} event, so it has a gap: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The most recent activity and a page of the kept records, newest first — see `AuditJournalPort.recent`. */
  async recent(limit: number, keptOffset = 0): Promise<AuditReading> {
    return await this.options.journal.recent(limit, keptOffset);
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
