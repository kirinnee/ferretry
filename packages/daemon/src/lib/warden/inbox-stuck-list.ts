import {
  AGENDA_PUSH_TITLE_LENGTH,
  clipAtWord,
  MAX_AGENDA_DETAIL_LENGTH,
  MAX_AGENDA_SUBJECT_LENGTH,
} from '@ferretry/protocol';
import type { MachineAgendaPort, MachineMembersStore } from '../agenda/machine-agenda.ts';
import { SerialQueue } from '../agenda/serial-queue.ts';

/** The ref of the one machine item every ferret whose inbox is stuck is listed on. */
const INBOX_STUCK_REF = 'warden:inbox-stuck';

const MAX_LISTED = 12;

/** One ferret on the notice: its name, the line about it, and since when. */
export interface StuckInboxNotice {
  readonly sessionId: string;
  readonly title: string;
  readonly line: string;
  readonly since: string;
}

/**
 * The ferrets whose messages wait in Ferretry's own queue far past due, as ONE machine item (docs/agenda.md
 * § The machine agenda; `inbox-stuck.ts`). A ferret joins when the Warden's safe re-check did not move its
 * queue, and leaves when its queue is no longer stuck; the item closes when the list is empty.
 */
export class StuckInboxList {
  private readonly queue = new SerialQueue();

  constructor(
    private readonly store: MachineMembersStore,
    private readonly machine: MachineAgendaPort,
  ) {}

  add(notice: StuckInboxNotice): Promise<void> {
    return this.queue.run(async () => {
      const held = await this.store.read();
      await this.store.write({ ...held, [notice.sessionId]: [notice.title, notice.line, notice.since] });
      await this.refresh();
    });
  }

  remove(sessionId: string): Promise<void> {
    return this.queue.run(async () => {
      const held = await this.store.read();
      if (held[sessionId] === undefined) return;
      const { [sessionId]: _gone, ...rest } = held;
      await this.store.write(rest);
      await this.refresh();
    });
  }

  private async refresh(): Promise<void> {
    const held = await this.store.read();
    const ids = Object.keys(held).sort();
    if (ids.length === 0) {
      await this.machine.resolve(INBOX_STUCK_REF, 'Every stuck inbox has drained.');
      return;
    }
    const lines = ids.slice(0, MAX_LISTED).map(id => `- ${held[id]?.[1] ?? id}`);
    const more = ids.length > MAX_LISTED ? [`…and ${ids.length - MAX_LISTED} more.`] : [];
    const since = ids.map(id => held[id]?.[2] ?? '').sort()[0] ?? new Date().toISOString();
    const only = held[ids[0] ?? ''];
    await this.machine.raiseOrUpdate(
      INBOX_STUCK_REF,
      {
        title: clipAtWord(
          ids.length === 1
            ? `${only?.[0] ?? 'A ferret'} has messages stuck in Ferretry's queue`
            : `${ids.length} ferrets have messages stuck in Ferretry's queue`,
          AGENDA_PUSH_TITLE_LENGTH,
        ),
        subject: clipAtWord(
          ids.length === 1
            ? (only?.[1] ?? '')
            : 'Each has messages waiting in Ferretry’s queue long past due, and the Warden’s safe re-check did not move them.',
          MAX_AGENDA_SUBJECT_LENGTH,
        ),
        why:
          'Messages sent to these ferrets have not been delivered long after they were due: something at the head of ' +
          'each queue is not moving, and every later message waits behind it. The Warden re-checked each one safely — ' +
          'it re-proves a send from the transcript and the screen, and types one again only when proven never to have ' +
          'arrived — and the queue is still stuck. An investigation has been asked to look.',
        premise: 'The Warden read it from each ferret’s message queue and its send ledger.',
        context: clipAtWord([...lines, ...more].join('\n'), MAX_AGENDA_DETAIL_LENGTH),
        howToResolve:
          'Open the ferret: a draft in its box that is a person’s can be sent or cleared there; a dialog needs answering; ' +
          'a message held for a revive needs the ferret revived. Restarting the daemon also re-checks every send. Nothing ' +
          'is resent or deleted for you. A ferret leaves this list once its queue moves again.',
        waitingSince: since,
        notice: true,
        ping: true,
        kind: 'info',
      },
      ids,
    );
  }
}
