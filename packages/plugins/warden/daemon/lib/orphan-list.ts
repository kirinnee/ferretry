import { CardIdSchema } from '@ferretry/plugin-board/contract';
import {
  AGENDA_PUSH_TITLE_LENGTH,
  clipAtWord,
  MAX_AGENDA_DETAIL_LENGTH,
  MAX_AGENDA_SUBJECT_LENGTH,
} from './protocol.ts';
import type { MachineAgendaPort, MachineMembersStore } from './machine-notices.ts';
import { SerialQueue } from './serial-queue.ts';
import { orphanTitle, type WardenCardNotice } from './orphans.ts';

/** The ref of the one machine item every card with nobody working on it is listed on. */
export const ORPHANS_REF = 'warden:orphans';

const MAX_LISTED = 12;

/**
 * The cards with nobody working on them, as ONE machine item (docs/agenda.md § The machine agenda). A card joins when the
 * Warden has no live owner ferret to tell, and leaves when a ferret is on it again; the item closes when the
 * list is empty. Each card is kept with its title and subject so the item can name it after a restart.
 */
export class OrphanList {
  private readonly queue = new SerialQueue();

  constructor(
    private readonly store: MachineMembersStore,
    private readonly machine: MachineAgendaPort,
    private readonly nowIso: () => string,
  ) {}

  /** `quiet` raises without a push (the boot folding). */
  add(notice: WardenCardNotice, quiet = false): Promise<void> {
    return this.queue.run(async () => {
      const held = await this.store.read();
      await this.store.write({ ...held, [notice.task.id]: [notice.title, notice.subject, notice.waitingSince] });
      await this.refresh(quiet);
    });
  }

  remove(taskId: string): Promise<void> {
    return this.queue.run(async () => {
      const held = await this.store.read();
      if (held[taskId] === undefined) return;
      const { [taskId]: _gone, ...rest } = held;
      await this.store.write(rest);
      await this.refresh();
    });
  }

  private async refresh(quiet = false): Promise<void> {
    const held = await this.store.read();
    const ids = Object.keys(held).sort();
    if (ids.length === 0) {
      await this.machine.resolve(ORPHANS_REF, 'A ferret is on every card again.');
      return;
    }
    const listed = ids.slice(0, MAX_LISTED);
    const lines = listed.map(id => `- ${held[id]?.[1] ?? id}`);
    const more = ids.length > MAX_LISTED ? [`…and ${ids.length - MAX_LISTED} more.`] : [];
    const since = ids.map(id => held[id]?.[2] ?? '').sort()[0] ?? this.nowIso();
    await this.machine.raiseOrUpdate(
      ORPHANS_REF,
      {
        title: clipAtWord(orphanTitle(ids.length), AGENDA_PUSH_TITLE_LENGTH),
        subject: clipAtWord(
          ids.length === 1
            ? (held[ids[0] ?? '']?.[1] ?? '')
            : 'These cards are waiting, but no ferret is assigned to any of them, so nothing will happen to them.',
          MAX_AGENDA_SUBJECT_LENGTH,
        ),
        why:
          ids.length === 1
            ? 'A card only moves when a ferret works on it. This one was handed to a ferret that has since finished, so it will sit where it is until you act.'
            : 'A card only moves when a ferret works on it. These were handed to ferrets that have since finished, so they will sit where they are until you act.',
        premise:
          ids.length === 1
            ? 'Ferretry saw this card on the board with no ferret working on it.'
            : 'Ferretry saw these cards on the board with no ferret working on any of them.',
        context: clipAtWord([...lines, ...more].join('\n'), MAX_AGENDA_DETAIL_LENGTH),
        howToResolve:
          'For each card: open it to see where it stands, start a ferret on it to carry on, or close it if it is no longer needed. A card leaves this list once a ferret is on it again. Tap Got it to dismiss the notice.',
        waitingSince: since,
        notice: true,
        ...(quiet ? {} : { ping: true as const }),
        kind: 'info',
        cards: listed.map(id => ({ task: { id: CardIdSchema.parse(id) }, line: held[id]?.[1] ?? id })),
      },
      ids,
    );
  }
}
