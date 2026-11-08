import type { AuditDraft, AuditRecord } from '../../../contract/index.ts';
import {
  AUDIT_KEPT_DAILY_ALLOWANCE,
  auditFoldKey,
  auditRecord,
  isOwnersOwnRecord,
  withinAuditBounds,
} from './policy.ts';

/**
 * the audit's one writer and reader (today's `lib/audit/service.ts`, copied; `Date.parse` / `Date.now` are the
 * kernel clock). AN AUDIT WRITE NEVER DECIDES AN OUTCOME: a record describes something that has already happened, so
 * a write that fails is said out loud to the operator, never thrown into the call.
 */

/** How long repeats of one refusal, or of one act of activity, are folded into a single count. */
export const AUDIT_FOLD_WINDOW_MS = 60_000;
/** At most this many windows are open at once; a full table closes every window first. */
const AUDIT_MAX_OPEN_FOLDS = 1_024;
const DAY_MS = 86_400_000;
const DETAIL_TEXT_MAX = 160;

/** Which store a line goes to: `kept` holds the successes a reader must never lose; `general` everything else. */
export type AuditStore = 'kept' | 'general';
/** `never`: a full store REFUSES the line rather than rotating, so nothing a device does pushes a kept record off. */
export type AuditRotation = 'rotate' | 'never';

/** What one bounded read found (today's `AuditReading`). */
export interface AuditReading {
  readonly records: readonly AuditRecord[];
  readonly kept: readonly AuditRecord[];
  readonly keptTotal: number;
  readonly unreadable: number;
}

/** The two bounded append-only stores (today's `AuditJournalPort`). */
export interface AuditJournalPort {
  /** `false` when the store was full and `rotation` was `never`, so nothing was written. */
  append(record: AuditRecord, store: AuditStore, rotation?: AuditRotation): Promise<boolean>;
  recent(limit: number, keptOffset: number): Promise<AuditReading>;
}

export interface AuditLogOptions {
  readonly journal: AuditJournalPort;
  readonly clock: { now(): string; nowMs(): number };
  /** Where a failed audit write is said out loud, since it may not be thrown into the call. */
  readonly failures: (message: string) => void;
}

interface AuditFold {
  readonly startedMs: number;
  repeats: number;
  readonly entry: AuditDraft;
}

interface KeptAllowance {
  readonly day: number;
  spent: number;
}

interface Overspent {
  readonly day: number;
  repeats: number;
  readonly entry: AuditDraft;
  readonly subjects: string[];
  unnamed: number;
}

export class AuditLog {
  readonly #folds = new Map<string, AuditFold>();
  readonly #allowances = new Map<string, KeptAllowance>();
  readonly #overspent = new Map<string, Overspent>();

  constructor(private readonly options: AuditLogOptions) {}

  /** Writes one record — or, for a REPEAT inside its fold window, counts it. */
  async record(entry: AuditDraft): Promise<void> {
    const at = this.options.clock.now();
    const atMs = this.options.clock.nowMs();
    const key = auditFoldKey(entry);
    if (key === undefined) {
      await this.#keep(entry, at, atMs);
      return;
    }
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

  async #keep(entry: AuditDraft, at: string, atMs: number): Promise<void> {
    if (isOwnersOwnRecord(entry)) {
      await this.#write(entry, at, 'kept');
      return;
    }
    const day = Math.floor(atMs / DAY_MS);
    const current = this.#allowances.get(entry.event);
    const allowance = current !== undefined && current.day === day ? current : { day, spent: 0 };
    this.#allowances.set(entry.event, allowance);
    allowance.spent += 1;
    if (allowance.spent <= AUDIT_KEPT_DAILY_ALLOWANCE) {
      await this.#write(entry, at, 'kept');
      return;
    }
    await this.#overspend(entry, at, day);
  }

  async #overspend(entry: AuditDraft, at: string, day: number): Promise<void> {
    const key = `${entry.event}|${entry.actor.kind}`;
    const open = this.#overspent.get(key);
    await this.#write(entry, at, 'general');
    if (open !== undefined && open.day === day) {
      open.repeats += 1;
      const named = [...open.subjects, entry.subject ?? ''].join(',');
      if (entry.subject !== undefined && named.length <= DETAIL_TEXT_MAX - 8) open.subjects.push(entry.subject);
      else open.unnamed += 1;
      return;
    }
    if (open !== undefined) await this.#closeOverspent(key, open, at);
    this.#overspent.set(key, { day, repeats: 0, entry, subjects: [], unnamed: 0 });
    await this.#write({ ...entry, detail: { ...entry.detail, keptAllowanceSpent: true } }, at, 'kept');
  }

  async #closeOverspent(key: string, open: Overspent, at: string): Promise<void> {
    this.#overspent.delete(key);
    if (open.repeats === 0) return;
    const subjects =
      open.subjects.length === 0
        ? undefined
        : open.unnamed === 0
          ? open.subjects.join(',')
          : `${open.subjects.join(',')},+${String(open.unnamed)}`;
    await this.#write(
      {
        event: open.entry.event,
        actor: { kind: open.entry.actor.kind },
        outcome: open.entry.outcome,
        ...(open.entry.cause === undefined ? {} : { cause: open.entry.cause }),
        detail: { keptAllowanceSpent: true, repeats: open.repeats, ...(subjects === undefined ? {} : { subjects }) },
      },
      at,
      'kept',
    );
  }

  /** Closes every window that has run its length, writing each one's count (the `audit flush` job, J-0004). */
  async flush(nowMs: number = this.options.clock.nowMs()): Promise<void> {
    await this.#closeFolds(nowMs);
    const day = Math.floor(nowMs / DAY_MS);
    for (const [key, open] of [...this.#overspent])
      if (open.day < day) await this.#closeOverspent(key, open, this.options.clock.now());
  }

  async #closeFolds(nowMs: number): Promise<void> {
    for (const [key, open] of [...this.#folds]) {
      if (nowMs - open.startedMs < AUDIT_FOLD_WINDOW_MS) continue;
      await this.#close(key, open, this.options.clock.now());
    }
  }

  async #close(key: string, open: AuditFold, at: string): Promise<void> {
    this.#folds.delete(key);
    if (open.repeats === 0) return;
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

  async #write(entry: AuditDraft, at: string, store: AuditStore): Promise<void> {
    try {
      const record = auditRecord(withinAuditBounds(entry), at);
      const fromHere = isOwnersOwnRecord(entry) || store === 'general';
      if (await this.options.journal.append(record, store, fromHere ? 'rotate' : 'never')) return;
      this.options.failures(
        `the audit's kept store is full, so a ${entry.event} event from somebody who is not this machine was written to the ordinary history instead, where newer activity can rotate it away; this machine's own next kept record makes room`,
      );
      await this.options.journal.append(record, 'general');
    } catch (error) {
      this.options.failures(
        `the audit could not record a ${entry.event} event, so it has a gap: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async recent(limit: number, keptOffset = 0): Promise<AuditReading> {
    return await this.options.journal.recent(limit, keptOffset);
  }
}
