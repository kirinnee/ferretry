/**
 * The two answers on the confirm screen, in the shared answer row: "Not now" (secondary, left) and "Pair this device"
 * (primary, right) on a desktop, stacked full width on a phone. The page decides when pairing is allowed and what it sends.
 */
import { ActionRow } from '@ferretry/app/ui';
import { PairButton } from './pairing-back.tsx';

export interface PairConfirmActionsProps {
  readonly busy: boolean;
  /** Pairing is blocked (no usable device name, or a machine name the daemon would refuse). */
  readonly blocked: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function PairConfirmActions({ busy, blocked, onCancel, onConfirm }: PairConfirmActionsProps) {
  return (
    <ActionRow
      secondary={
        <PairButton type="button" onClick={onCancel} disabled={busy}>
          Not now
        </PairButton>
      }
      primary={
        <PairButton
          type="button"
          data-variant="primary"
          data-pair-confirm=""
          onClick={onConfirm}
          disabled={busy || blocked}
        >
          {busy ? 'Pairing…' : 'Pair this device'}
        </PairButton>
      }
    />
  );
}
