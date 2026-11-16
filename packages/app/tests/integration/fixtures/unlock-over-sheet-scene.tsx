/**
 * The browser entry for "the passkey prompt paints over an open body-level sheet": the shell's REAL `PasskeyMount` inside the
 * REAL fixed `.fy-frame` (the shipping stylesheet), the app's REAL `BottomSheet` portalled to `document.body` (z-40, exactly as the
 * Agenda ⋯ options sheet does it), and a stand-in for Access's prompt (an app test reaches another package only
 * through its contract): the same box as Access's `StepUpDialog` — `position: fixed; inset: 0; z-index: 70`, the same
 * `useDialogFocus` — with a confirm button that does nothing. No ceremony, no WebAuthn, no network, no credential.
 *
 *   ?theme=<family>-<mode>
 *   window.raiseUnlock()  -> a background unlock for the machine on screen, opened as `PasskeyHandler`'s gate would
 */

import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { useRef, useState, useSyncExternalStore } from 'react';
import type { PasskeyHandler, PasskeyProvision } from '../../../src/passkey/passkey.ts';
import { ShellContext, type ShellModel } from '../../../src/shell/context.tsx';
import { PasskeyMount } from '../../../src/shell/passkey-mount.tsx';
import { BottomSheet } from '../../../src/ui/bottom-sheet.tsx';
import { useDialogFocus } from '../../../src/ui/hooks/use-dialog-focus.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

// ─── the fake gate: one open/closed fact the prompt reads, raised for the machine on screen only ───────────────────────────
const listeners = new Set<() => void>();
let onScreen: string | null = null;
let raised = false;
const emit = (): void => {
  for (const listener of listeners) listener();
};
const handler: PasskeyHandler = {
  need: () => undefined,
  confirm: async () => false,
  ask: async () => false,
  focus: daemon => {
    onScreen = daemon;
  },
  locked: () => [],
  subscribe: listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
Object.assign(window, {
  raiseUnlock: () => {
    // `PasskeyMount` told the handler which machine is on screen; only that machine's background read may ask.
    if (onScreen === null) return;
    raised = true;
    emit();
  },
});

function Prompts() {
  const open = useSyncExternalStore(
    handler.subscribe,
    () => raised,
    () => raised,
  );
  const ref = useRef<HTMLDivElement | null>(null);
  const dismiss = (): void => {
    raised = false;
    emit();
  };
  const { onKeyDown } = useDialogFocus(open, ref, dismiss);
  if (!open) return null;
  return (
    <div
      data-passkey-layer=""
      role="presentation"
      style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'flex-end', padding: 8 }}
    >
      <button
        type="button"
        aria-label="Cancel the passkey confirmation"
        onClick={dismiss}
        style={{ position: 'absolute', inset: 0, background: 'var(--scrim, rgba(0,0,0,.4))' }}
      />
      <div
        ref={ref}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Unlock"
        data-step-up-dialog=""
        className="kt-panel"
        style={{ position: 'relative', width: '100%', maxWidth: 448, margin: '0 auto', padding: 16 }}
      >
        <h2 style={{ margin: 0 }}>Unlock</h2>
        <p>Unlock Fake machine with your passkey.</p>
        <button type="button" data-step-up-confirm="">
          Unlock
        </button>
        <button type="button" onClick={dismiss}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const provision = { handler, Prompts } as unknown as PasskeyProvision;
// `PasskeyMount` reads only `runtime.passkey()`.
const shell = { runtime: { passkey: () => provision } } as unknown as ShellModel;

function Scene() {
  const [open, setOpen] = useState(false);
  return (
    <ShellContext.Provider value={shell}>
      <div className="fy-frame fy-frame--nav-left">
        <div style={{ padding: '80px 20px' }}>
          <button type="button" data-options-toggle="" onClick={() => setOpen(true)}>
            Item options
          </button>
        </div>
        {createPortal(
          <BottomSheet
            id="item-options"
            open={open}
            onClose={() => setOpen(false)}
            ariaLabel="Item options"
            closeLabel="Close options"
          >
            {['1 hour', '4 hours', 'Tomorrow', 'Custom', 'Merge', 'Not needed'].map(label => (
              <button key={label} type="button" style={{ display: 'block', width: '100%', padding: 12 }}>
                {label}
              </button>
            ))}
          </BottomSheet>,
          document.body,
        )}
        <PasskeyMount onScreen="fake-machine" />
      </div>
    </ShellContext.Provider>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
