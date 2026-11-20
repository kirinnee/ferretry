/**
 * THE PAIRING PAGE'S WAY BACK. `/pair` is drawn without the shell's chrome (no sidebar, no bars), so a person who
 * opened it from Settings, or came from the first run, needs a control of its own that leaves. The host decides where
 * it goes (`onClose`); with nowhere to go (a cold first visit) none is drawn.
 */
export function PairingBack({ onClose }: { readonly onClose: () => void }) {
  return (
    <button
      type="button"
      className="kt-btn min-h-[44px] self-start px-4 py-3"
      data-variant="ghost"
      data-pairing-close=""
      onClick={onClose}
    >
      Back
    </button>
  );
}
