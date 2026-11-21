import type { ButtonHTMLAttributes } from 'react';

/**
 * A pairing-page button: the shared `kt-btn` chrome, the 44 px touch floor and the `fy-pair-btn` hook the 136 px
 * width rule in `styles.css` selects. Callers add placement and padding through `className`.
 */
export function PairButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...rest} className={`kt-btn min-h-[44px] fy-pair-btn ${className ?? ''}`} />;
}

/**
 * THE PAIRING PAGE'S WAY BACK. `/pair` is drawn without the shell's chrome (no sidebar, no bars), so a person who
 * opened it from Settings, or came from the first run, needs a control of its own that leaves. The host decides where
 * it goes (`onClose`); with nowhere to go (a cold first visit) none is drawn.
 */
export function PairingBack({ onClose }: { readonly onClose: () => void }) {
  return (
    <PairButton type="button" className="self-start px-4 py-3" data-pairing-close="" onClick={onClose}>
      Back
    </PairButton>
  );
}
