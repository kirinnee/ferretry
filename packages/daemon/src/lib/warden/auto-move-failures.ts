import {
  AGENDA_PUSH_TITLE_LENGTH,
  clipAtWord,
  MAX_AGENDA_DETAIL_LENGTH,
  MAX_AGENDA_SUBJECT_LENGTH,
} from '@ferretry/protocol';
import type { MachineAgendaPort, MachineMembersStore } from '../agenda/machine-agenda.ts';
import { SerialQueue } from '../agenda/serial-queue.ts';

/** The ref of the one machine item every ferret the Warden could not move is listed on. */
export const AUTO_MOVE_FAILED_REF = 'warden:auto-move-failed';

/** Where a ferret is now, or `undefined` when it is stopped or gone: either one needs no move. */
export interface AutoMoveFacts {
  current(sessionId: string): Promise<{ readonly agent: string; readonly name?: string } | undefined>;
}

const MAX_LISTED = 12;

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
    for (const [id, entry] of Object.entries(held)) {
      const now = await this.facts.current(id);
      if (now === undefined || now.agent !== entry[0]) continue;
      kept[id] = entry;
      if (now.name !== undefined) names.set(id, now.name);
    }
    if (Object.keys(kept).length !== Object.keys(held).length) await this.store.write(kept);
    const ids = Object.keys(kept).sort();
    if (ids.length === 0)
      return await this.machine.resolve(AUTO_MOVE_FAILED_REF, 'Every ferret is moved, stopped or gone.');
    const lines = ids.slice(0, MAX_LISTED).map(id => `${names.get(id) ?? id} (${id}): ${kept[id]?.[1] ?? ''}`);
    const more = ids.length > MAX_LISTED ? [`…and ${ids.length - MAX_LISTED} more.`] : [];
    const subject = ids.length === 1 ? `${ids[0]} could not be moved` : `${ids.length} ferrets could not be moved`;
    await this.machine.raiseOrUpdate(
      AUTO_MOVE_FAILED_REF,
      {
        title: clipAtWord(subject, AGENDA_PUSH_TITLE_LENGTH),
        subject: clipAtWord(ids.join(', '), MAX_AGENDA_SUBJECT_LENGTH),
        why:
          'The Warden moves a ferret whose login hit a limit to another login, as warden.yaml (autoMigrate) allows. ' +
          'These stayed where they are.',
        context: clipAtWord([...lines, ...more].join('\n'), MAX_AGENDA_DETAIL_LENGTH),
        howToResolve:
          'Move a ferret yourself with the command beside its name (pick the runtime to move it onto), or wait for its login to reset.',
        waitingSince: new Date().toISOString(),
        premise: 'The owner let the Warden move ferrets that hit a limit to another login.',
        notice: true,
        ...(quiet ? {} : { ping: true as const }),
        kind: 'info',
      },
      ids,
    );
  }
}
