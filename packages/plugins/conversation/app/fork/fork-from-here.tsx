/**
 * "FORK FROM HERE…" ON A MESSAGE THE PERSON SENT (the foot of a user row in the transcript). One small button that opens
 * {@link ForkDialog} on this message: the form lists what was said, opened on this one, and the fork keeps the conversation
 * through the end of its turn. Drawn only inside a chat that says which ferret it is (`RowSlotProvider`), and only where
 * this device may fork on the machine.
 */

import { GitFork } from 'lucide-react';
import { useState } from 'react';
import { useRowSlotPlace } from '../chat/row-slots.tsx';
import { ForkDialog, useForkControl } from './fork-dialog.tsx';

export function ForkFromHere({ offsets }: { readonly offsets: readonly number[] }) {
  const place = useRowSlotPlace();
  const control = useForkControl();
  // The row's offsets as they were when it was clicked, so a chat that redraws under the open form does not re-read it.
  const [opened, setOpened] = useState<readonly number[] | null>(null);
  if (place === null || !control.shown || offsets.length === 0) return null;
  return (
    <>
      <button
        aria-label="Fork from here…"
        className="fy-ledger-more fy-fork-here"
        data-fork-from-here=""
        disabled={!control.enabled}
        onClick={() => setOpened(offsets)}
        title={control.enabled ? 'Fork from here…' : (control.note ?? 'Fork from here…')}
        type="button"
      >
        <GitFork aria-hidden="true" size={13} />
      </button>
      {opened === null ? null : <ForkDialog at={opened} ferret={place.ferret} onClose={() => setOpened(null)} />}
    </>
  );
}
