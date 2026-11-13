/**
 * DELIVERING A DONE: when the OWNER marks a card done, its ferret is told in one plain message — "The
 * owner marked &F412 “Title” done." — down the same ladder a reopen takes (the assignee, then the card's
 * owner ferret). Cards closed together are grouped by who is told, so each ferret gets ONE message listing
 * them. The messenger is the owner's front, so the app shows the owner's chip. A close made on the admin token
 * says so instead of "The owner": that token may be a ferret without its own credential (`ADMIN_TOKEN_ACTOR_WORDS`).
 */
import type { DoneNotice, DoneNotifier } from './ports.ts';
import { type ReopenMessenger, rungsOf, walkLadder } from './reopen-delivery.ts';
import { doneMessage } from './service.ts';

/** The idempotency key of one done message: every card in it and the history event that closed it. */
export const doneKey = (notices: readonly DoneNotice[]): string =>
  `board-done-${notices.map(({ task }) => `${task.id}-${task.history.at(-1)?.seq ?? 0}`).join('+')}`;

export class DoneDeliveryLadder implements DoneNotifier {
  constructor(
    private readonly messenger: ReopenMessenger,
    private readonly diagnostics: { warn(message: string): void },
  ) {}

  async done(notices: readonly DoneNotice[]): Promise<void> {
    // Grouped by who is told AND by who closed them, so one message never names the wrong closer.
    const groups = new Map<string, DoneNotice[]>();
    for (const notice of notices) {
      const rungs = rungsOf(notice.task);
      const key = `${notice.by}\n${rungs.join('\n')}`;
      groups.set(key, [...(groups.get(key) ?? []), notice]);
    }
    for (const group of groups.values()) {
      const [first] = group;
      if (first === undefined) continue;
      await walkLadder(
        this.messenger,
        this.diagnostics,
        rungsOf(first.task),
        doneMessage(
          group.map(({ task }) => task),
          first.by,
        ),
        doneKey(group),
      );
    }
  }
}
