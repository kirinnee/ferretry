import type { ProcessEntry } from './model.ts';

/** How long an ended tool command stays listed. */
export const ENDED_PROCESS_RETENTION_MS = 15 * 60 * 1000;
/** How many ended tool commands one ferret keeps, newest first. */
export const ENDED_PROCESS_LIMIT = 30;
/** How many ferrets' histories the daemon keeps at once; the least recently looked at goes first. */
export const PROCESS_HISTORY_SESSION_LIMIT = 200;

export interface EndedProcess {
  readonly entry: ProcessEntry;
  readonly endedAtMs: number;
}

interface SessionHistory {
  /** The last look's live entries, by id: one missing from the next look has ended. */
  live: ReadonlyMap<string, ProcessEntry>;
  /** CPU seconds at the last look, for a rate rather than a lifetime average. */
  samples: ReadonlyMap<string, { readonly cpuSeconds: number; readonly atMs: number }>;
  ended: readonly EndedProcess[];
}

/**
 * WHAT THE DAEMON REMEMBERS BETWEEN LOOKS, AND NOTHING MORE. The processes themselves are the operating
 * system's; this keeps only what a single look cannot see — that a command which was there is gone, and
 * how much CPU it had used last time — so the tab can show "ended 2m ago" and a CPU rate.
 *
 * In memory only, bounded per ferret ({@link ENDED_PROCESS_LIMIT}, {@link ENDED_PROCESS_RETENTION_MS})
 * and across ferrets ({@link PROCESS_HISTORY_SESSION_LIMIT}). A daemon restart forgets it, which costs a
 * few "recently ended" rows and nothing else.
 */
export class ProcessHistory {
  private readonly sessions = new Map<string, SessionHistory>();

  /** Records one look at a ferret's live processes and answers which tool commands ended since the last. */
  observe(sessionId: string, live: readonly ProcessEntry[], nowMs: number): readonly EndedProcess[] {
    const previous = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    const current = new Map(live.map(entry => [entry.id, entry]));
    const newlyEnded: EndedProcess[] = [];
    for (const [id, entry] of previous?.live ?? [])
      if (!current.has(id) && entry.toolCommand) newlyEnded.push({ entry, endedAtMs: nowMs });
    const ended = [...newlyEnded, ...(previous?.ended ?? [])]
      .filter(item => nowMs - item.endedAtMs <= ENDED_PROCESS_RETENTION_MS)
      .slice(0, ENDED_PROCESS_LIMIT);
    const samples = new Map<string, { cpuSeconds: number; atMs: number }>();
    for (const entry of live)
      if (entry.row.cpuSeconds !== undefined) samples.set(entry.id, { cpuSeconds: entry.row.cpuSeconds, atMs: nowMs });
    this.sessions.set(sessionId, { live: current, samples, ended });
    while (this.sessions.size > PROCESS_HISTORY_SESSION_LIMIT) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return ended;
  }

  /** Every live entry the last look saw ended, as of `nowMs` — for a ferret whose pane is gone. */
  endAll(sessionId: string, nowMs: number): readonly EndedProcess[] {
    return this.observe(sessionId, [], nowMs);
  }

  sample(sessionId: string, id: string): { readonly cpuSeconds: number; readonly atMs: number } | undefined {
    return this.sessions.get(sessionId)?.samples.get(id);
  }

  ended(sessionId: string, id: string): EndedProcess | undefined {
    return this.sessions.get(sessionId)?.ended.find(item => item.entry.id === id);
  }
}
