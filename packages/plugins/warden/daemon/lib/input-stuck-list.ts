import {
  AGENDA_PUSH_TITLE_LENGTH,
  clipAtWord,
  MAX_AGENDA_DETAIL_LENGTH,
  MAX_AGENDA_SUBJECT_LENGTH,
} from './protocol.ts';
import type { MachineAgendaPort, MachineMembersStore } from './machine-notices.ts';
import { SerialQueue } from './serial-queue.ts';

/** The ref of the one machine item every ferret stuck behind its own unsent message is listed on. */
export const INPUT_STUCK_REF = 'warden:input-stuck';

const MAX_LISTED = 12;

/** One ferret on the notice: its name, the line about it, and since when. */
export interface StuckInputNotice {
  readonly sessionId: string;
  readonly title: string;
  readonly line: string;
  readonly since: string;
}

/**
 * The ferrets idle with a message of Ferretry's own typed and unsubmitted in their box, as ONE machine item
 * (docs/agenda.md § The machine agenda; `input-stuck.ts`). A ferret joins when the Warden's Enter did not
 * submit the message, and leaves when it is no longer flagged; the item closes when the list is empty.
 */
export class StuckInputList {
  private readonly queue = new SerialQueue();

  constructor(
    private readonly store: MachineMembersStore,
    private readonly machine: MachineAgendaPort,
    private readonly nowIso: () => string,
  ) {}

  add(notice: StuckInputNotice): Promise<void> {
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
      await this.machine.resolve(INPUT_STUCK_REF, 'Every ferret has taken its message.');
      return;
    }
    const lines = ids.slice(0, MAX_LISTED).map(id => `- ${held[id]?.[1] ?? id}`);
    const more = ids.length > MAX_LISTED ? [`…and ${ids.length - MAX_LISTED} more.`] : [];
    const since = ids.map(id => held[id]?.[2] ?? '').sort()[0] ?? this.nowIso();
    const only = held[ids[0] ?? ''];
    await this.machine.raiseOrUpdate(
      INPUT_STUCK_REF,
      {
        title: clipAtWord(
          ids.length === 1
            ? `${only?.[0] ?? 'A ferret'} is stuck on an unsent message`
            : `${ids.length} ferrets are stuck on unsent messages`,
          AGENDA_PUSH_TITLE_LENGTH,
        ),
        subject: clipAtWord(
          ids.length === 1
            ? (only?.[1] ?? '')
            : 'Each is idle with a message typed in its box and not sent; messages sent after it wait behind it.',
          MAX_AGENDA_SUBJECT_LENGTH,
        ),
        why:
          'Ferretry typed a message into the ferret and its Enter never took, so the ferret is idle at its prompt ' +
          'with the message unsent, and every later message waits behind it. Ferretry pressed Enter again and it ' +
          'did not submit.',
        premise: 'The Warden read it from the ferret’s state and its send ledger.',
        context: clipAtWord([...lines, ...more].join('\n'), MAX_AGENDA_DETAIL_LENGTH),
        howToResolve:
          'Open the ferret and press Enter on the message in its box (or the message’s ⋯ → Press Enter), or clear ' +
          'it and send it again. A ferret leaves this list once it takes a turn again.',
        waitingSince: since,
        notice: true,
        ping: true,
        kind: 'info',
      },
      ids,
    );
  }
}
