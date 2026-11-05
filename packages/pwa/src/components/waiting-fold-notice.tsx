/**
 * THE TRACE OF MESSAGES THE CHAT FOLDED OUT.
 *
 * A message still waiting to go into the ferret is not drawn in the conversation (`waiting-fold.ts`); it
 * lives on the Queue page. Hiding it with no trace left a person wondering where a message they just sent
 * had gone, so the chat says how many are waiting and where they are. One quiet line above the composer;
 * a door to the Queue page when the page can navigate, plain text when it cannot.
 */

export interface WaitingFoldNoticeProps {
  /** How many waiting messages the chat left out. Nothing is drawn for zero. */
  readonly count: number;
  /** Opens the Queue page for this ferret. Absent: the line is text only. */
  readonly onOpenQueue?: () => void;
}

/** "1 message waiting — on the Queue page" / "3 messages waiting — on the Queue page". */
export const waitingFoldLine = (count: number): string =>
  `${count} ${count === 1 ? 'message' : 'messages'} waiting — on the Queue page`;

export function WaitingFoldNotice({ count, onOpenQueue }: WaitingFoldNoticeProps) {
  if (count <= 0) return null;
  const line = waitingFoldLine(count);
  return (
    <div className="py-1 text-meta text-muted" data-waiting-fold={count} role="status">
      {onOpenQueue === undefined ? (
        line
      ) : (
        <button
          className="rounded-sm text-left underline decoration-dotted underline-offset-2 hover:text-fg"
          onClick={onOpenQueue}
          type="button"
        >
          {line}
        </button>
      )}
    </div>
  );
}
