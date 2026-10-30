import { Button } from '../../shell/primitives.tsx';

export interface AgendaRepliesNoticeProps {
  /** The ferret the answers are going to. */
  readonly ferret: string;
  /** Whole seconds left; `null` draws nothing unless the answers are held for the ferret's turn. */
  readonly secondsLeft: number | null;
  /** The batch is due but the ferret is mid-turn: it goes when the turn ends. */
  readonly heldForTurn?: boolean;
  /** Due answers wait because the ferret's message box holds text; nothing is typed over it. */
  readonly heldForComposer?: boolean;
  readonly sending: boolean;
  readonly onSendNow: () => void;
}

/** How long is left, in the unit a minute-scale wait reads naturally in: "45 s", "2 min". */
export const countdownWords = (seconds: number): string =>
  seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;

/**
 * "Sending to <ferret> in 2 min…" with a Send now button, while the daemon holds the owner's answers; once
 * the window has passed but the ferret is mid-turn, "Waiting for <ferret> to finish its turn…"; and while its
 * message box holds text, "Waiting for <ferret>'s message box to be empty…" — Send now cannot help there, so it
 * is not offered.
 */
export function AgendaRepliesNotice({
  ferret,
  secondsLeft,
  heldForTurn = false,
  heldForComposer = false,
  sending,
  onSendNow,
}: AgendaRepliesNoticeProps) {
  if (secondsLeft === null && !heldForTurn && !heldForComposer) return null;
  if (heldForComposer && secondsLeft === null)
    return (
      <p
        className="m-0 flex items-center gap-2 text-meta leading-base text-muted"
        data-agenda-replies="composer"
        role="status"
      >
        <span className="min-w-0 flex-1">Waiting for {ferret}'s message box to be empty…</span>
      </p>
    );
  return (
    <p className="m-0 flex items-center gap-2 text-meta leading-base text-muted" data-agenda-replies="" role="status">
      <span className="min-w-0 flex-1">
        {secondsLeft === null
          ? `Waiting for ${ferret} to finish its turn…`
          : `Sending to ${ferret} in ${countdownWords(secondsLeft)}…`}
      </span>
      <Button data-agenda-send-now="" disabled={sending} onClick={onSendNow} variant="ghost">
        Send now
      </Button>
    </p>
  );
}
