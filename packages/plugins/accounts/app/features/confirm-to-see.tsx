/**
 * What an ask card draws in place of its data while the daemon wants the owner's step-up for the read and the owner has
 * not acted yet. Pressing it is the owner's act, so the passkey is asked for then and only then.
 */

import { CONFIRM_TO_SEE_WORDS } from '../lib/step-up-refusal.ts';

export function ConfirmToSee({ onConfirm }: { readonly onConfirm: () => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-confirm-to-see="">
      <button className="kt-btn min-h-[44px] self-start" data-variant="primary" onClick={onConfirm} type="button">
        {CONFIRM_TO_SEE_WORDS}
      </button>
    </div>
  );
}
