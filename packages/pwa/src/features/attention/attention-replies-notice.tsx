import { Button } from '../../shell/primitives.tsx';

export interface AttentionRepliesNoticeProps {
  /** The ferret the answers are going to. */
  readonly ferret: string;
  /** Whole seconds left; `null` draws nothing. */
  readonly secondsLeft: number | null;
  readonly sending: boolean;
  readonly onSendNow: () => void;
}

/** "Sending to <ferret> in N s…" with a Send now button, while the daemon holds the owner's answers. */
export function AttentionRepliesNotice({ ferret, secondsLeft, sending, onSendNow }: AttentionRepliesNoticeProps) {
  if (secondsLeft === null) return null;
  return (
    <p
      className="m-0 flex items-center gap-2 text-meta leading-base text-muted"
      data-attention-replies=""
      role="status"
    >
      <span className="min-w-0 flex-1">
        Sending to {ferret} in {secondsLeft} s…
      </span>
      <Button data-attention-send-now="" disabled={sending} onClick={onSendNow} variant="ghost">
        Send now
      </Button>
    </p>
  );
}
