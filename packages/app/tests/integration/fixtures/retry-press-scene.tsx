/**
 * The browser entry for "a Try again opens the passkey dialog, even after a Cancel": the app's REAL `useContextRead` and
 * `ContextFailure` (the shared Try again every list uses), and a fake machine that answers a read with "confirm it's you"
 * unless the read is the person's own press (`quiet: false`, the shared `readPress`). A press opens a stand-in for Access's
 * prompt (the same box as `StepUpDialog`); the page's own opening read never does. No ceremony, no WebAuthn, no network.
 *
 *   ?theme=<family>-<mode>
 */

import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContextFailure, useContextRead } from '../../../src/ui/context-list.tsx';
import type { ReadPress } from '../../../src/ui/read-press.ts';
import { useDialogFocus } from '../../../src/ui/hooks/use-dialog-focus.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const REFUSED = 'This machine asks you to confirm it’s you with a passkey before it shows anything.';

function Prompt({ onCancel }: { readonly onCancel: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { onKeyDown } = useDialogFocus(true, ref, onCancel);
  return (
    <div
      data-passkey-layer=""
      role="presentation"
      style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'flex-end', padding: 8 }}
    >
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
        <button type="button" data-step-up-cancel="" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Scene() {
  const [prompts, setPrompts] = useState(0);
  const [open, setOpen] = useState(false);
  // The fake machine: a read that is not a press is refused quietly (no prompt); a press asks, and is refused again.
  const loader = useRef(async (_signal: AbortSignal, press: ReadPress): Promise<string> => {
    if (press.quiet === false) {
      setPrompts(count => count + 1);
      setOpen(true);
    }
    throw new Error(REFUSED);
  });
  const read = useContextRead(loader.current, true);
  return (
    <main style={{ padding: 20, maxWidth: 560, margin: '0 auto' }}>
      <h1>Fake machine · Skills</h1>
      {read.load.kind === 'failed' ? (
        <ContextFailure
          machineName="Fake machine"
          what="read this machine’s skills"
          reason={read.load.reason}
          onRetry={read.reload}
        />
      ) : (
        <p>Reading…</p>
      )}
      <p data-prompts={prompts}>Prompts opened: {prompts}</p>
      {open ? <Prompt onCancel={() => setOpen(false)} /> : null}
    </main>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
