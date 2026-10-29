import { Button } from '../../shell/primitives.tsx';

export interface AttentionRepliesNoticeProps {
  /** The ferret the answers are going to. */
  readonly ferret: string;
  /** Whole seconds left; `null` draws nothing unless the answers are held for the ferret's turn. */
  readonly secondsLeft: number | null;
  /** The batch is due but the ferret is mid-turn: it goes when the turn ends. */
  readonly heldForTurn?: boolean;
  readonly sending: boolean;
  readonly onSendNow: () => void;
}

/** How long is left, in the unit a minute-scale wait reads naturally in: "45 s", "2 min". */
export const countdownWords = (seconds: number): string =>
  seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;

/**
 * "Sending to <ferret> in 2 min…" with a Send now button, while the daemon holds the owner's answers; once
 * the window has passed but the ferret is mid-turn, "Waiting for <ferret> to finish its turn…".
 */
export function AttentionRepliesNotice({
  ferret,
  secondsLeft,
  heldForTurn = false,
  sending,
  onSendNow,
}: AttentionRepliesNoticeProps) {
  if (secondsLeft === null && !heldForTurn) return null;
  return (
    <p
      className="m-0 flex items-center gap-2 text-meta leading-base text-muted"
      data-attention-replies=""
      role="status"
    >
      <span className="min-w-0 flex-1">
        {secondsLeft === null
          ? `Waiting for ${ferret} to finish its turn…`
          : `Sending to ${ferret} in ${countdownWords(secondsLeft)}…`}
      </span>
      <Button data-attention-send-now="" disabled={sending} onClick={onSendNow} variant="ghost">
        Send now
      </Button>
    </p>
  );
}
