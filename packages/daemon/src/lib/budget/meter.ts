/**
 * What this machine's sessions on a login cost in a period (docs/budgets.md) — the number a budget is
 * judged against.
 *
 * WHY NOT THE ANALYTICS INDEX. The index holds a session only once it has ENDED, and books its whole cost
 * at the instant it was created. A budget has to stop sessions that are still running, and a lead that runs
 * for three days has to count against the day each request was made, not the day it started. So the meter
 * reads every transcript itself, through the append-only window (`TranscriptWindow`), from the start of the
 * period onward, and books each request at its OWN timestamp. A read costs the bytes written since the last
 * one. Nothing is persisted: the transcripts own the fact, and a restart reads the period again.
 *
 * WHAT IT COUNTS. A session's own transcript and its sub-agents' (Claude writes a sub-agent's conversation to
 * a file of its own, which the analytics index does not read). A request is booked to the login its session
 * ran on AT THAT TIME, by its whole history of moves: a session moved A→B→C books what it did before the
 * first move to A, between them to B, after them to C. A file a session no longer names (a migration that
 * converted its conversation, a Restart onto another transcript) KEEPS what it booked to the end of the period:
 * those requests were made and spent. A Claude message is counted once even when it appears in two files (a
 * fork or a resume copies the conversation): the first file read owns it.
 *
 * A file whose window could not reach back to the start of the period (a transcript with more than the window
 * cap written since then) is read from where the cap allows and marked PARTIAL, so the view says the amount
 * may be low rather than passing it off as complete.
 *
 * WHAT IT DOES NOT. Requests on the same login from another machine, or from outside Ferretry. A request
 * whose model has no price is counted as UNPRICED, never as $0.
 *
 * Amounts are kept in 15-minute slots: every zone's offset is a whole number of quarter hours, so any day or
 * week in any zone is an exact run of slots, and a week is at most 672 numbers per file.
 */
import type { AnalyticsTokenUsage } from '../analytics/pricing.ts';
import type { TranscriptHarness, TranscriptWindow } from '../transcript/types.ts';
import { type SpendFoldCarry, spendRecords } from './spend-fold.ts';

const SLOT_MS = 15 * 60_000;

/** One move a session made: what it did before `atMs` (and after any earlier move) belongs to `from`. */
export interface MeteredMove {
  readonly from: string;
  readonly atMs: number;
}

/** One session the meter may read. */
export interface MeteredSession {
  readonly id: string;
  readonly harness: TranscriptHarness;
  /** The executable it runs as now (a runtime's wrapper name), or `null` when it names none. */
  readonly agent: string | null;
  /** Every move it made, oldest first. */
  readonly moves: readonly MeteredMove[];
}

/** One transcript file of a session, in the grammar of the harness that wrote it. */
export interface MeteredFile {
  readonly path: string;
  readonly harness: TranscriptHarness;
}

export interface SpendMeterPorts {
  /** Every session that may have run since `sinceMs`: running, or updated since then. */
  sessions(sinceMs: number): Promise<readonly MeteredSession[]>;
  /**
   * A session's transcript files — its own, its sub-agents', and the one a conversion moved it off — or none
   * when it has no transcript yet.
   */
  files(session: MeteredSession): Promise<readonly MeteredFile[]>;
  /** An append-only read of `file` from the first record at or after `sinceIso`. */
  window(file: string, harness: TranscriptHarness, sinceIso: string): TranscriptWindow;
  /** Prices for this refresh: one request's equivalent cost in micro-dollars, or `undefined` when unpriced. */
  pricing(): Promise<(usage: AnalyticsTokenUsage) => number | undefined>;
}

/** What the sessions on some runtimes cost in a span. */
export interface MeteredSpend {
  readonly usdMicros: number;
  /** Requests in the span whose model has no price. */
  readonly unpriced: number;
  /** A file on these runtimes could not be read from the start of the period, so the amount may be low. */
  readonly partial: boolean;
}

/** One file being read: where its window is, and what it has booked so far, by agent and slot. */
interface FileTrack {
  readonly sessionId: string;
  readonly harness: TranscriptHarness;
  readonly window: TranscriptWindow | undefined;
  carry: SpendFoldCarry;
  /** Its window could not reach back to the start of the period. */
  partial: boolean;
  /** Every agent a session reading this file ran as: whose spend a partial read makes partial. */
  readonly agents: Set<string>;
  /** agent → slot → micro-dollars. */
  readonly micros: Map<string, Map<number, number>>;
  /** agent → slot → unpriced requests. */
  readonly unpriced: Map<string, Map<number, number>>;
}

/** What one Claude message was booked as, so a later line of it replaces rather than adds. */
interface BookedMessage {
  readonly file: string;
  readonly agent: string;
  readonly slot: number;
  /** `undefined` when it was booked unpriced. */
  readonly micros: number | undefined;
}

const bump = (table: Map<string, Map<number, number>>, agent: string, slot: number, by: number): void => {
  const slots = table.get(agent) ?? new Map<number, number>();
  const next = (slots.get(slot) ?? 0) + by;
  if (next === 0) slots.delete(slot);
  else slots.set(slot, next);
  table.set(agent, slots);
};

/** The agent a request at `atMs` was made on: the `from` of the first move after it, else where it runs now. */
const agentAt = (session: MeteredSession, atMs: number): string | null =>
  session.moves.find(move => atMs < move.atMs)?.from ?? session.agent;

export class SpendMeter {
  readonly #tracks = new Map<string, FileTrack>();
  readonly #messages = new Map<string, BookedMessage>();
  #sinceMs: number | undefined;
  #measured = false;

  constructor(private readonly ports: SpendMeterPorts) {}

  /** Whether one refresh has finished since the meter was made: before it, every amount reads low. */
  get measured(): boolean {
    return this.#measured;
  }

  /**
   * Read what the sessions on `agents` wrote since the last refresh, from `sinceMs` on. A `sinceMs` later
   * than the last one drops what came before it; an earlier one starts the read over.
   */
  async refresh(sinceMs: number, agents: ReadonlySet<string>): Promise<void> {
    if (this.#sinceMs === undefined || sinceMs < this.#sinceMs) this.#clear();
    else if (sinceMs > this.#sinceMs) this.#prune(sinceMs);
    this.#sinceMs = sinceMs;
    const sinceIso = new Date(sinceMs).toISOString();

    const wanted = (await this.ports.sessions(sinceMs)).filter(
      session =>
        (session.agent !== null && agents.has(session.agent)) || session.moves.some(move => agents.has(move.from)),
    );
    const price = await this.ports.pricing();
    const seen = new Set<string>();
    for (const session of wanted) {
      // A session whose files cannot be named this time keeps what it booked: nothing is read, nothing goes.
      const files = await this.ports.files(session).catch((): readonly MeteredFile[] => []);
      for (const { path: file, harness } of files) {
        seen.add(file);
        let track = this.#tracks.get(file);
        if (track === undefined) {
          track = {
            sessionId: session.id,
            harness,
            window: this.#open(file, harness, sinceIso),
            carry: {},
            partial: false,
            agents: new Set(),
            micros: new Map(),
            unpriced: new Map(),
          };
          this.#tracks.set(file, track);
        }
        for (const agent of [session.agent, ...session.moves.map(move => move.from)])
          if (agent !== null) track.agents.add(agent);
        await this.#read(file, track, session, price);
      }
    }
    // A file nobody names any more — a rebound transcript, a session gone quiet — keeps what it booked until
    // the period moves past all of it, and only then is let go.
    for (const [file, track] of this.#tracks) {
      if (seen.has(file)) continue;
      const empty = [...track.micros.values(), ...track.unpriced.values()].every(slots => slots.size === 0);
      if (empty) this.#drop(file);
    }
    this.#measured = true;
  }

  /** What the sessions on `agents` cost in `[startMs, endMs)`. */
  spent(agents: ReadonlySet<string>, startMs: number, endMs: number): MeteredSpend {
    const first = Math.floor(startMs / SLOT_MS);
    const last = Math.ceil(endMs / SLOT_MS);
    let usdMicros = 0;
    let unpriced = 0;
    let partial = false;
    const sum = (slots: Map<number, number> | undefined): number => {
      let total = 0;
      for (const [slot, amount] of slots ?? []) if (slot >= first && slot < last) total += amount;
      return total;
    };
    for (const track of this.#tracks.values()) {
      if (track.partial && [...agents].some(agent => track.agents.has(agent))) partial = true;
      for (const agent of agents) {
        usdMicros += sum(track.micros.get(agent));
        unpriced += sum(track.unpriced.get(agent));
      }
    }
    return { usdMicros, unpriced, partial };
  }

  #open(file: string, harness: TranscriptHarness, sinceIso: string): TranscriptWindow | undefined {
    try {
      return this.ports.window(file, harness, sinceIso);
    } catch {
      return undefined;
    }
  }

  async #read(
    file: string,
    track: FileTrack,
    session: MeteredSession,
    price: (usage: AnalyticsTokenUsage) => number | undefined,
  ): Promise<void> {
    if (track.window === undefined) return;
    for (;;) {
      // A file that went away keeps what it booked: the requests in it were made, and spent.
      const step = await track.window.next().catch(() => undefined);
      if (step === undefined) return;
      const batch = step.batch;
      if (batch !== undefined) {
        if (batch.reset) this.#forget(file, track);
        if (batch.issues.some(issue => issue.code === 'window-capped')) track.partial = true;
        const folded = spendRecords(batch.events, track.harness, track.carry);
        track.carry = folded.carry;
        for (const record of folded.records) this.#book(file, track, session, record, price);
      }
      if (!step.more) return;
    }
  }

  #book(
    file: string,
    track: FileTrack,
    session: MeteredSession,
    record: ReturnType<typeof spendRecords>['records'][number],
    price: (usage: AnalyticsTokenUsage) => number | undefined,
  ): void {
    if (this.#sinceMs !== undefined && record.atMs < this.#sinceMs) return;
    const agent = agentAt(session, record.atMs);
    if (agent === null) return;
    const slot = Math.floor(record.atMs / SLOT_MS);
    const micros = record.usage === undefined ? undefined : price(record.usage);
    if (record.messageId !== undefined) {
      const booked = this.#messages.get(record.messageId);
      // Another file already holds this message: a copy of the same request, not a second one.
      if (booked !== undefined && booked.file !== file) return;
      if (booked !== undefined) this.#unbook(track, booked);
      this.#messages.set(record.messageId, { file, agent, slot, micros });
    }
    if (micros === undefined) bump(track.unpriced, agent, slot, 1);
    else bump(track.micros, agent, slot, micros);
  }

  #unbook(track: FileTrack, booked: BookedMessage): void {
    if (booked.micros === undefined) bump(track.unpriced, booked.agent, booked.slot, -1);
    else bump(track.micros, booked.agent, booked.slot, -booked.micros);
  }

  /** A file that restarted (replaced or truncated): what it booked goes, and it is read again from the top. */
  #forget(file: string, track: FileTrack): void {
    track.micros.clear();
    track.unpriced.clear();
    track.carry = {};
    for (const [id, booked] of this.#messages) if (booked.file === file) this.#messages.delete(id);
  }

  #drop(file: string): void {
    const track = this.#tracks.get(file);
    if (track !== undefined) this.#forget(file, track);
    this.#tracks.delete(file);
  }

  #clear(): void {
    this.#tracks.clear();
    this.#messages.clear();
  }

  /** Drop every slot before `sinceMs`: the period moved on. Windows keep their place. */
  #prune(sinceMs: number): void {
    const first = Math.floor(sinceMs / SLOT_MS);
    for (const track of this.#tracks.values()) {
      for (const table of [track.micros, track.unpriced]) {
        for (const slots of table.values()) for (const slot of slots.keys()) if (slot < first) slots.delete(slot);
      }
    }
    for (const [id, booked] of this.#messages) if (booked.slot < first) this.#messages.delete(id);
  }
}
