/**
 * ASKS' LINK TO TASKS (docs/agenda.md § Task asks): which open asks carry each task, and which of those are the task's
 * own gate ask, the one the owner has yet to answer. Asks owns the fact; a task only DERIVES from it (its `openAsks`,
 * and that it is never stale while its ask is open), so the task store holds no copy and answering the ask clears it
 * with no write to the task.
 *
 * A task links TWO kinds of ask. Its own gate obligation (source `card`, whose entry names the task) is the one the
 * owner has yet to answer (`asking`): the open `task` asks are read in ONE call, whatever the size of the board, and
 * grouped by the task each names. (The board once read the ledger of every task's owner and assignee, and their
 * homes, for these same asks: O(ferrets) reads of every task list, closed tasks included.) A gate ask on a ledger
 * outside the board's ferrets therefore shows too.
 *
 * The other is an ask a ferret RAISED about the task (`fy agenda add --task F9`): "what is waiting on the owner for
 * this task". It is read from the agenda items that name the task (`task`, or `relatedTasks` after a merge) and is
 * only ever `open`, never `asking`: the task's gate behaviour is the gate ask's alone. An answered ask is resolved,
 * so it is not read. A notice is context, never an ask, so it is not counted.
 */
import type { AskRef } from '../../../contract/index.ts';
import type { Task, TaskId } from '../../../contract/index.ts';
import type { TaskAskLinkSource, TaskAsks } from './ports.ts';

/** The part of an open task ask the link reads. */
export interface OpenTaskAsk {
  /** The ferret whose ledger the ask lives on. */
  readonly ferret: string;
  /** The ask's id on that ledger (`A12`). */
  readonly id: string;
  /** The task whose gate obligation it is. */
  readonly cardId: TaskId;
  /** A notice is context, never an ask. */
  readonly notice?: boolean | undefined;
}

/** What the link reads from Asks: the gate asks, and the asks ferrets raised about a task. Each read stands alone. */
export interface TaskAskReader {
  /** Every open ask of the `task` source, read through Asks (`AsksApi.open`) in one call. */
  open(): Promise<readonly OpenTaskAsk[]>;
  /** Every open ask a ferret raised about a card, one entry per card it names (`AsksApi.snapshots`). */
  mentioned(): Promise<readonly OpenTaskAsk[]>;
}

export class TaskAskLinks implements TaskAskLinkSource {
  constructor(
    private readonly asks: TaskAskReader,
    private readonly diagnostics: { warn(message: string): void },
  ) {}

  async asksFor(tasks: readonly Task[], signal?: AbortSignal): Promise<ReadonlyMap<TaskId, TaskAsks>> {
    signal?.throwIfAborted();
    const wanted = new Set<TaskId>(tasks.map(task => task.id));
    const found = new Map<TaskId, { open: AskRef[]; asking: AskRef[] }>();
    const gates = await this.read(() => this.asks.open());
    signal?.throwIfAborted();
    const mentions = await this.read(() => this.asks.mentioned());
    signal?.throwIfAborted();
    for (const item of gates) {
      if (item.notice === true || !wanted.has(item.cardId)) continue;
      const ref: AskRef = { ferret: item.ferret, id: item.id };
      const entry = found.get(item.cardId) ?? { open: [], asking: [] };
      entry.open.push(ref);
      entry.asking.push(ref);
      found.set(item.cardId, entry);
    }
    for (const item of mentions) {
      if (item.notice === true || !wanted.has(item.cardId)) continue;
      const entry = found.get(item.cardId) ?? { open: [], asking: [] };
      if (entry.open.some(ref => ref.ferret === item.ferret && ref.id === item.id)) continue;
      entry.open.push({ ferret: item.ferret, id: item.id });
      found.set(item.cardId, entry);
    }
    return found;
  }

  /** Asks that cannot be read costs the tasks their asks, never the board read (nor the other kind of ask). */
  private async read(read: () => Promise<readonly OpenTaskAsk[]>): Promise<readonly OpenTaskAsk[]> {
    try {
      return await read();
    } catch (error) {
      this.diagnostics.warn(
        `could not read the asks of the tasks: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
