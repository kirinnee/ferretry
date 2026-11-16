import { Button } from '@ferretry/app/ui';

/** What pressing Confirm on one held edit came to. */
export type ConfirmState =
  | { readonly status: 'idle' }
  | { readonly status: 'busy' }
  | { readonly status: 'failed'; readonly sentence: string };

export const IDLE: ConfirmState = { status: 'idle' };

/** Confirm for one held edit. A remote device is asked for a passkey by the shell around the call; nothing here asks. */
export function ConfirmButton({
  state,
  onConfirm,
  name,
}: {
  readonly state: ConfirmState;
  readonly onConfirm: () => void;
  readonly name: string;
}) {
  return (
    <>
      <Button
        type="button"
        variant="primary"
        className="min-h-[44px]"
        data-config-confirm={name}
        disabled={state.status === 'busy'}
        onClick={onConfirm}
      >
        {state.status === 'busy' ? 'Confirming…' : 'Confirm'}
      </Button>
      {state.status === 'failed' ? (
        <span
          role="alert"
          className="min-w-0 break-words text-cell leading-base text-err"
          data-config-confirm-failed=""
        >
          {state.sentence}
        </span>
      ) : null}
    </>
  );
}
