/**
 * A FERRET'S PENDING CONTEXT: quiet board events (`board-design.md` §2.8) held for a session until its
 * NEXT turn, never starting one.
 *
 * A child card that moves, blocks or unblocks, and a blocker that ships, is worth one line to the lead —
 * but not a turn: a message would wake the lead and cost it context for news it needs only when it next
 * works. So the line waits here, and rides at the top of the next message the session is sent anyway (the
 * owner's, a teammate's, or the board's own nudge), as one batched line:
 *
 *     [board] &F413 → Review/CI (PR #930) · &F414 waiting on owner (!A9)
 *
 * - **Coalesced by key.** A later item with the same key replaces the earlier one, so a card that moved
 *   twice before the lead's next turn says only where it is now.
 * - **Bounded.** At most {@link MAX_PENDING_ITEMS}, newest kept: a lead away for a week reads a line,
 *   not a page.
 * - **Taken, then restored on failure**, so a send that is refused loses nothing.
 *
 * GAP: the agenda's answer batches and the Warden's nudges are sent below the send route this rides, so
 * they do not carry it; the lead hears it with the message after.
 */

/** One quiet event, without the `[board]` mark: `&F413 → Review/CI (PR #930)`. */
export interface QuietItem {
  /** What coalesces: `F413:lane`, `F414:asks`. */
  readonly key: string;
  readonly text: string;
  readonly at: string;
}

/** Where quiet events wait for a session's next turn. */
export interface PendingContext {
  append(sessionId: string, items: readonly QuietItem[]): Promise<void>;
}

/** The delivery side: the send path takes what is held, and puts it back if the send fails. */
export interface PendingContextQueue extends PendingContext {
  /** Removes and returns everything held for the session, oldest first. */
  take(sessionId: string): Promise<readonly QuietItem[]>;
  /** Puts back what a failed send took, ahead of anything appended since. */
  restore(sessionId: string, items: readonly QuietItem[]): Promise<void>;
}

export const MAX_PENDING_ITEMS = 32;
export const BOARD_MARK = '[board]';

/** `held` with `incoming` appended: a repeated key keeps only its newest item, and only the newest are kept. */
export const mergeQuietItems = (held: readonly QuietItem[], incoming: readonly QuietItem[]): readonly QuietItem[] => {
  const merged: QuietItem[] = [];
  for (const item of [...held, ...incoming]) {
    const earlier = merged.findIndex(each => each.key === item.key);
    if (earlier !== -1) merged.splice(earlier, 1);
    merged.push(item);
  }
  return merged.slice(-MAX_PENDING_ITEMS);
};

/** The one line a batch reads as. */
export const quietLine = (items: readonly QuietItem[]): string =>
  `${BOARD_MARK} ${items.map(item => item.text).join(' · ')}`;

/** A message with the held context on top; the message itself unchanged. */
export const withQuietContext = (items: readonly QuietItem[], message: string): string =>
  items.length === 0 ? message : `${quietLine(items)}\n\n${message}`;

/**
 * Sends a message with the session's pending context on top. Total about the context: a store that
 * cannot be read sends the message bare, and a send that fails puts the context back before it rethrows.
 *
 * `carried` says whether what the send path kept is the message this call composed. A retried request
 * the send path answers from its earlier record did not carry the line, so the context goes back.
 */
export class PendingContextDelivery {
  constructor(private readonly context: PendingContextQueue) {}

  async send<T>(
    sessionId: string,
    message: string,
    send: (message: string) => Promise<T>,
    carried: (result: T, line: string) => boolean = () => true,
  ): Promise<T> {
    const items = await this.context.take(sessionId).catch((): readonly QuietItem[] => []);
    if (items.length === 0) return await send(message);
    const restore = async () => await this.context.restore(sessionId, items).catch(() => undefined);
    let result: T;
    try {
      result = await send(withQuietContext(items, message));
    } catch (error) {
      await restore();
      throw error;
    }
    if (!carried(result, quietLine(items))) await restore();
    return result;
  }
}
