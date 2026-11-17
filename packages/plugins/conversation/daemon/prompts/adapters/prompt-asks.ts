import { type AskRef, type AsksApi, AskIdSchema, EntryIdSchema, type SourceKey } from '@ferretry/core-asks/contract';
import type { PromptWaitRecord } from '../../../contract/wire-prompt.ts';
import {
  promptEntry,
  promptKey,
  promptRefOfKey,
  promptSubject,
  readPrompt,
  type PromptRead,
} from '../lib/prompt-wait.ts';

/** The ask source Conversation registers (`ask.sources:prompt`). */
const PROMPT_SOURCE = 'prompt' as SourceKey;

/** The most words a card carries as context (Asks' own bound is far larger; a prompt is never near it). */
const MAX_CONTEXT = 8_000;

/**
 * What the prompt obligations need of Asks: raise (idempotent by source and entry) and close. `open` (by source and
 * entry) is asked only to find a card whose ref was never saved: never on a steady tick.
 */
export type PromptAsksPort = Pick<AsksApi, 'raise' | 'close' | 'open'>;

/** Conversation's own memory of each ferret's waits, one record per ferret, replaced whole (`PROMPT_WAIT_STATE`). */
export interface PromptRecords {
  /** The ferrets that have a record. */
  list(): Promise<readonly string[]>;
  /** Throws when the record exists and cannot be read: a damaged record is not "no record". */
  read(ferret: string): Promise<PromptWaitRecord | undefined>;
  write(ferret: string, record: PromptWaitRecord): Promise<void>;
  remove(ferret: string): Promise<void>;
}

/** One ferret as the sweep sees it: its lifecycle state (`idle` is the one a parked pane is in; `stopped` waits on nobody). */
export interface PromptRoster {
  readonly id: string;
  readonly state: 'starting' | 'working' | 'idle' | 'stopped';
}

/**
 * THE PROMPT OBLIGATIONS: a ferret parked on a permission prompt or a harness dialog waits on the owner exactly like
 * an ask does, so it IS an Agenda card (Asks' source `prompt`), raised once per wait and closed the moment the wait
 * ends (answered in the console, the pane moved on, the ferret stopped or went away). Nothing here answers the prompt.
 *
 * The question watch's tick drives it, but a tick reads nothing on its own: a pane is read only for a ferret that was
 * REPORTED CHANGED since the last sweep ({@link changed}: Ferrets said its state moved), that is owed a card (its record
 * says it is waiting) or whose last look failed, plus ONE reconciliation of every ferret that could be parked (`idle`) on
 * the first sweep after boot. Twenty idle ferrets nobody touched cost no read. A card is closed by the ref this sweep
 * was handed when it raised it, kept in {@link PromptRecords}; a raise that succeeded but whose ref was not saved (the
 * save failed, the daemon died) is found again by its durable `(source, entry)` before its record is cleared, replaced
 * or removed, so no card is stranded and none is doubled (a child's card lands on its lead's board: the board a card is
 * on says nothing about whose it is). A raise or a close that failed is asked again by the next sweep, and said once
 * until it works.
 *
 * Each wait is an OCCURRENCE: the same prompt asked again after the wait was positively seen to end is a new card,
 * because Asks keeps `(source, entry)` for life. Only a positive reading ends a wait: an empty or failed read is no
 * evidence, so a transient `{}` never closes a card. Nor does it settle a ferret that was reported changed: its read is
 * asked again (one per sweep) until a positive reading comes back, or the one event that said it moved is lost.
 */
export class PromptAsks {
  readonly #failing = new Set<string>();
  /** The ferrets reported changed since the last sweep took them. */
  #changed = new Set<string>();
  #reconciled = false;
  #records: Map<string, PromptWaitRecord> | undefined;

  constructor(
    private readonly asks: PromptAsksPort,
    private readonly read: (ferret: string) => Promise<PromptRead | undefined>,
    private readonly store: PromptRecords,
    private readonly warn: (message: string) => void,
  ) {}

  /** Ferrets said this ferret changed (its state, its stop, its removal): the next sweep reads its pane. */
  changed(ferret: string): void {
    this.#changed.add(ferret);
  }

  /** Makes the Agenda say what the panes that could be parked say. Never throws: a failure is said once and retried. */
  async sweep(roster: readonly PromptRoster[]): Promise<void> {
    const records = await this.#loaded();
    if (records === undefined) return;
    const live = new Map(roster.map(ferret => [ferret.id, ferret.state]));
    const owed = [...records].filter(([, record]) => record.waiting || record.ask !== undefined).map(([id]) => id);
    const reported = [...this.#changed];
    this.#changed = new Set();
    const first = !this.#reconciled;
    this.#reconciled = true;
    const candidates = new Set([
      ...(first ? roster.filter(ferret => ferret.state === 'idle').map(ferret => ferret.id) : []),
      ...reported.filter(id => live.get(id) === 'idle'),
      ...owed,
      ...[...this.#failing].filter(id => live.get(id) === 'idle'),
    ]);
    for (const id of this.#failing) if (!candidates.has(id)) this.#failing.delete(id);
    const reportedIds = new Set(reported);
    for (const id of candidates) {
      try {
        const state = live.get(id);
        let known = true;
        if (state === undefined || state === 'stopped') await this.#ended(id, state === undefined);
        else known = await this.#look(id);
        // An unknown reading (`{}`, no turn state) of a ferret that was reported changed or is already owed a retry is no
        // evidence: it stays eligible, one read per sweep, until a POSITIVE reading settles it. Unsaid: it is not a failure.
        if (known || !(reportedIds.has(id) || this.#failing.has(id))) this.#failing.delete(id);
        else this.#failing.add(id);
      } catch (error) {
        this.#fail(id, `conversation could not follow the prompt of ${id}: ${String(error)}`);
      }
    }
  }

  /** The records, read once after boot: what the last run left is what this one reconciles. */
  async #loaded(): Promise<Map<string, PromptWaitRecord> | undefined> {
    if (this.#records !== undefined) return this.#records;
    try {
      const loaded = new Map<string, PromptWaitRecord>();
      for (const id of await this.store.list()) {
        const record = await this.store.read(id);
        if (record !== undefined) loaded.set(id, record);
      }
      this.#failing.delete('');
      this.#records = loaded;
      return loaded;
    } catch (error) {
      this.#fail('', `conversation could not read what it recorded of the prompts: ${String(error)}`);
      return undefined;
    }
  }

  #fail(key: string, message: string): void {
    if (!this.#failing.has(key)) this.warn(message);
    this.#failing.add(key);
  }

  /** Reads the pane once: `false` when the reading was unknown (no evidence), `true` when it settled the ferret. */
  async #look(id: string): Promise<boolean> {
    const reading = readPrompt(await this.read(id));
    if (reading.kind === 'unknown') return false;
    if (reading.kind === 'ended') {
      await this.#ended(id, false);
      return true;
    }
    const { ref, words } = reading.wait;
    const key = promptKey(ref);
    let record = this.#records?.get(id);
    if (record?.waiting !== true || record.key !== key) {
      // A new wait: another prompt than the one held, or the same one again after the wait was seen to end.
      if (record !== undefined) await this.#withdraw(id, record);
      record = { format: 1, key, occurrence: (record?.occurrence ?? 0) + 1, waiting: true };
      await this.#save(id, record);
    }
    if (record.ask !== undefined) return true;
    const entry = EntryIdSchema.parse(promptEntry(id, ref, record.occurrence));
    const raised = await this.asks.raise({
      source: PROMPT_SOURCE,
      ref,
      entry,
      kind: 'task',
      subject: promptSubject(id, ref),
      why: `${id} is waiting on a prompt only you can answer.`,
      howToResolve: 'Answer it in the ferret’s console; this ask closes by itself when the wait ends.',
      context: words.slice(0, MAX_CONTEXT),
      raisedBy: { kind: 'daemon' },
      ferret: id,
      blocking: true,
    });
    await this.#save(id, { ...record, ask: { ferret: raised.ferret, id: raised.id, entry } });
    return true;
  }

  /** A positive reading that the wait is over (or the ferret is gone): its card is closed by the ref it was raised with. */
  async #ended(id: string, gone: boolean): Promise<void> {
    const record = this.#records?.get(id);
    if (record === undefined) return;
    await this.#withdraw(id, record);
    if (gone) {
      await this.store.remove(id);
      this.#records?.delete(id);
    } else if (record.waiting || record.ask !== undefined) {
      const { ask: _ask, ...rest } = record;
      await this.#save(id, { ...rest, waiting: false });
    }
  }

  /**
   * Closes the card of a record's occurrence before the record is cleared, replaced or removed. The saved ref names it;
   * with none saved but the wait recorded, a raise may have succeeded whose ref was never written, so the card is found
   * by its durable `(source, entry)` (the entry is deterministic) wherever Asks put it, and every one open is closed.
   */
  async #withdraw(id: string, record: PromptWaitRecord): Promise<void> {
    if (record.ask !== undefined) return await this.#close(record.ask);
    if (!record.waiting) return;
    const ref = promptRefOfKey(record.key);
    if (ref === undefined) return;
    const entry = EntryIdSchema.parse(promptEntry(id, ref, record.occurrence));
    for (const task of await this.asks.open({ source: PROMPT_SOURCE, entry }))
      await this.asks.close({ ferret: task.ferret ?? id, id: task.id }, 'withdrawn', entry);
  }

  async #close(ask: NonNullable<PromptWaitRecord['ask']>): Promise<void> {
    const ref: AskRef = { ferret: ask.ferret, id: AskIdSchema.parse(ask.id) };
    await this.asks.close(ref, 'withdrawn', EntryIdSchema.parse(ask.entry));
  }

  async #save(id: string, record: PromptWaitRecord): Promise<void> {
    await this.store.write(id, record);
    this.#records?.set(id, record);
  }
}
