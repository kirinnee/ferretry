/**
 * DELIVERING A DONE: when the OWNER marks a card done, its ferret is told in one plain message — "The
 * owner marked &F412 “Title” done." — down the same ladder a reopen takes (the assignee, then the card's
 * owner ferret). Cards closed together are grouped by who is told, so each ferret gets ONE message listing
 * them. The messenger is the owner's front, so the app shows the owner's chip.
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
    const groups = new Map<string, DoneNotice[]>();
    for (const notice of notices) {
      const rungs = rungsOf(notice.task);
      groups.set(rungs.join('\n'), [...(groups.get(rungs.join('\n')) ?? []), notice]);
    }
    for (const [rungs, group] of groups) {
      await walkLadder(
        this.messenger,
        this.diagnostics,
        rungs.split('\n'),
        doneMessage(group.map(({ task }) => task)),
        doneKey(group),
      );
    }
  }
}
