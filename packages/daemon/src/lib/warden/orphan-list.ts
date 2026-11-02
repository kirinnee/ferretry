import {
  AGENDA_PUSH_TITLE_LENGTH,
  clipAtWord,
  MAX_AGENDA_DETAIL_LENGTH,
  MAX_AGENDA_SUBJECT_LENGTH,
} from '@ferretry/protocol';
import type { MachineAgendaPort, MachineMembersStore } from '../agenda/machine-agenda.ts';
import type { WardenCardNotice } from './orphans.ts';

/** The ref of the one machine item every card with nobody on it is listed on. */
export const ORPHANS_REF = 'warden:orphans';

const MAX_LISTED = 12;

/**
 * The cards with nobody on them, as ONE machine item (docs/agenda.md § The machine agenda). A card joins when the
 * Warden has no live owner ferret to tell, and leaves when a ferret is on it again; the item closes when the
 * list is empty. Each card is kept with its title and subject so the item can name it after a restart.
 */
export class OrphanList {
  constructor(
    private readonly store: MachineMembersStore,
    private readonly machine: MachineAgendaPort,
  ) {}

  async add(notice: WardenCardNotice): Promise<void> {
    const held = await this.store.read();
    await this.store.write({ ...held, [notice.task.id]: [notice.title, notice.subject, notice.waitingSince] });
    await this.reconcile();
  }

  async remove(taskId: string): Promise<void> {
    const held = await this.store.read();
    if (held[taskId] === undefined) return;
    const { [taskId]: _gone, ...rest } = held;
    await this.store.write(rest);
    await this.reconcile();
  }

  private async reconcile(): Promise<void> {
    const held = await this.store.read();
    const ids = Object.keys(held).sort();
    if (ids.length === 0) return await this.machine.resolve(ORPHANS_REF, 'A ferret is on every card again.');
    const lines = ids.slice(0, MAX_LISTED).map(id => `- ${held[id]?.[1] ?? id}`);
    const more = ids.length > MAX_LISTED ? [`…and ${ids.length - MAX_LISTED} more.`] : [];
    const since = ids.map(id => held[id]?.[2] ?? '').sort()[0] ?? new Date().toISOString();
    await this.machine.raiseOrUpdate(
      ORPHANS_REF,
      {
        title: clipAtWord(
          ids.length === 1
            ? (held[ids[0] ?? '']?.[0] ?? 'A card has nobody on it')
            : `${ids.length} cards have nobody on them`,
          AGENDA_PUSH_TITLE_LENGTH,
        ),
        subject: clipAtWord(
          ids.length === 1 ? (held[ids[0] ?? '']?.[1] ?? '') : 'No ferret is working these cards.',
          MAX_AGENDA_SUBJECT_LENGTH,
        ),
        why: 'Each card is in an active or review lane, but its ferret is finished and nothing under it is alive.',
        premise: 'The Warden saw these on the board.',
        context: clipAtWord([...lines, ...more].join('\n'), MAX_AGENDA_DETAIL_LENGTH),
        howToResolve:
          'Open the card, then resume its ferret, hand the card to another ferret, or drop it. A card leaves this list once a ferret is on it again.',
        waitingSince: since,
        notice: true,
        ping: true,
        kind: 'info',
      },
      ids,
    );
  }
}
