import { useState } from 'react';
import type { PasskeyNeed } from '../passkey/passkey.ts';
import { useRuntimeVersion, useShell } from './context.tsx';

/** What the bar says for each passkey a machine wants, and the words on its one button. */
const WORDS: Readonly<Record<PasskeyNeed['kind'], { readonly line: string; readonly press: string }>> = {
  unlock: { line: 'This machine is locked until you confirm it’s you.', press: 'Unlock' },
  'step-up': { line: 'Part of this page needs you to confirm it’s you.', press: 'Confirm it’s you' },
};

/**
 * THE ONE PRESS FOR A PASSKEY NOBODY ASKED FOR YET (A555 r7).
 *
 * A read the person did not cause — the page loading after a reload or a deep link, a poll — raises no passkey prompt:
 * a modal nobody asked for, over the page, again and again, was the owner's "flickers ALOT". Its refusal is its answer.
 * But a refusal with no way to answer it is a dead end, and not every page draws its own "Confirm it's you". So when
 * the machine on screen refused such a read, the shell draws this one line with one button: pressing it is the person's
 * act, so it opens the ONE prompt (Access's, with "Add a passkey" in it for a device that holds none), and once
 * confirmed the machine's views are built again so they read again (`ShellRuntime.confirmUnasked`).
 *
 * Only for a machine the ROUTE names: a daemon-less screen (the pair-success screen, which offers its own "Add a passkey
 * now") draws its own words.
 */
export function PasskeyBar({ daemon }: { readonly daemon: string }) {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  const [busy, setBusy] = useState(false);
  const need = runtime.unaskedNeed(daemon);
  if (need === undefined) return null;
  const words = WORDS[need.kind];
  const press = (): void => {
    setBusy(true);
    void runtime.confirmUnasked(daemon).finally(() => setBusy(false));
  };
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-2 z-[60] flex justify-center px-2"
      data-passkey-bar={need.kind}
    >
      <div
        className="kt-panel pointer-events-auto flex min-w-0 max-w-md items-center gap-3 px-cell-x py-2 shadow-popover"
        role="status"
      >
        <p className="m-0 min-w-0 flex-1 text-ui leading-base text-fg">{words.line}</p>
        <button
          type="button"
          className="kt-btn shrink-0"
          data-variant="primary"
          data-passkey-bar-press=""
          disabled={busy}
          onClick={press}
        >
          {words.press}
        </button>
      </div>
    </div>
  );
}
