import {
  AGENDA_PUSH_TITLE_LENGTH,
  clipAtWord,
  MAX_AGENDA_DETAIL_LENGTH,
  MAX_AGENDA_SUBJECT_LENGTH,
} from './protocol.ts';
import type { MachineAgendaPort, MachineMembersStore } from './machine-notices.ts';
import { SerialQueue } from './serial-queue.ts';

/** The ref of the one machine item every ferret the Warden could not move is listed on. */
export const AUTO_MOVE_FAILED_REF = 'warden:auto-move-failed';

/** Where a ferret is now, or `undefined` when it is stopped or gone: either one needs no move. */
export interface AutoMoveFacts {
  current(
    sessionId: string,
  ): Promise<{ readonly agent: string; readonly name?: string; readonly midTurn?: boolean } | undefined>;
  /** The login the Warden's own candidate logic would move this ferret to now, or `undefined` when none can take it. */
  candidate(sessionId: string): Promise<string | undefined>;
}

/** The ferret's reason in a sentence: the Warden's "Not moved although X:" lead-in dropped. */
const reasonOf = (detail: string): string => {
  const bare = detail.replace(/^Not moved( although [^:]*)?:\s*/i, '').trim();
  const sentence = bare.length === 0 ? 'It could not be moved' : bare.charAt(0).toUpperCase() + bare.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
};

const MAX_LISTED = 12;

/** Whole lines that fit `limit`, newlines kept: the PWA reads one ferret per line. */
const fitLines = (lines: readonly string[], limit: number): string => {
  const fitted: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > limit) break;
    fitted.push(line);
    used += line.length + 1;
  }
  return fitted.join('\n');
};

/**
 * The ferrets the Warden could not move, as ONE machine item (docs/agenda.md § The machine agenda). Each is kept with the
 * login it was on when it failed; it leaves the list when it is stopped, gone, or on another login, and the item
 * closes when the list is empty. A stopped ferret is never listed.
 */
export class AutoMoveFailures {
  private readonly queue = new SerialQueue();

  constructor(
    private readonly store: MachineMembersStore,
    private readonly machine: MachineAgendaPort,
    private readonly facts: AutoMoveFacts,
    private readonly nowIso: () => string,
  ) {}

  /** The Warden could not move `sessionId`; `detail` says why. `quiet` raises without a push (the boot folding). */
  note(sessionId: string, detail: string, quiet = false): Promise<void> {
    return this.queue.run(async () => {
      const now = await this.facts.current(sessionId);
      if (now === undefined) return;
      const held = await this.store.read();
      await this.store.write({ ...held, [sessionId]: [now.agent, detail] });
      await this.refresh(quiet);
    });
  }

  /** Drop what no longer needs a move, then raise, refresh or close the item. */
  reconcile(): Promise<void> {
    return this.queue.run(async () => await this.refresh());
  }

  private async refresh(quiet = false): Promise<void> {
    const held = await this.store.read();
    const kept: Record<string, readonly string[]> = {};
    const names = new Map<string, string>();
    const midTurn = new Set<string>();
    for (const [id, entry] of Object.entries(held)) {
      const now = await this.facts.current(id);
      if (now === undefined || now.agent !== entry[0]) continue;
      kept[id] = entry;
      if (now.name !== undefined) names.set(id, now.name);
      if (now.midTurn === true) midTurn.add(id);
    }
    if (Object.keys(kept).length !== Object.keys(held).length) await this.store.write(kept);
    const ids = Object.keys(kept).sort();
    if (ids.length === 0) {
      await this.machine.resolve(AUTO_MOVE_FAILED_REF, 'Every ferret is moved, stopped or gone.');
      return;
    }
    const lines: string[] = [];
    for (const id of ids.slice(0, MAX_LISTED)) {
      const login = midTurn.has(id) ? undefined : await this.facts.candidate(id);
      const reason = reasonOf(kept[id]?.[1] ?? '');
      const action = midTurn.has(id)
        ? 'Wait for it to finish its turn.'
        : login === undefined
          ? 'Wait for a login to reset.'
          : 'A login can take it now:';
      lines.push(`${names.get(id) ?? id} (${id}): ${reason} ${action}`);
      if (login !== undefined) lines.push(`$ fy move ${id} -a ${login}`);
    }
    const more = ids.length > MAX_LISTED ? [`…and ${ids.length - MAX_LISTED} more.`] : [];
    const subject = ids.length === 1 ? `${ids[0]} could not be moved` : `${ids.length} ferrets could not be moved`;
    await this.machine.raiseOrUpdate(
      AUTO_MOVE_FAILED_REF,
      {
        title: clipAtWord(subject, AGENDA_PUSH_TITLE_LENGTH),
        subject: clipAtWord(ids.join(', '), MAX_AGENDA_SUBJECT_LENGTH),
        why:
          ids.length === 1
            ? "Ferretry moves a ferret to another login when its login hits a limit. This one couldn't be moved."
            : `Ferretry moves a ferret to another login when its login hits a limit. These ${ids.length} couldn't be moved.`,
        context: fitLines([...lines, ...more], MAX_AGENDA_DETAIL_LENGTH),
        howToResolve: 'Run the command under a ferret to move it yourself, or wait as its line says.',
        waitingSince: this.nowIso(),
        premise: 'The owner let the Warden move ferrets that hit a limit to another login.',
        notice: true,
        ...(quiet ? {} : { ping: true as const }),
        kind: 'info',
      },
      ids,
    );
  }
}
