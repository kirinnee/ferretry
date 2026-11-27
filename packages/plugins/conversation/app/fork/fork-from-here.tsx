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

export function ForkFromHere({ text }: { readonly text: string }) {
  const place = useRowSlotPlace();
  const control = useForkControl();
  const [open, setOpen] = useState(false);
  if (place === null || !control.shown || text.trim() === '') return null;
  return (
    <>
      <button
        aria-label="Fork from here…"
        className="fy-ledger-more fy-fork-here"
        data-fork-from-here=""
        disabled={!control.enabled}
        onClick={() => setOpen(true)}
        title={control.enabled ? 'Fork from here…' : (control.note ?? 'Fork from here…')}
        type="button"
      >
        <GitFork aria-hidden="true" size={13} />
      </button>
      {open ? <ForkDialog ferret={place.ferret} initial={text} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
