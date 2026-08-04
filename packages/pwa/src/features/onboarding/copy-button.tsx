/**
 * One-tap copy, and an honest answer when it does not work.
 *
 * Every command on the setup screen has to leave this page and land in a
 * terminal, usually on a different machine, often on a phone where selecting
 * monospace text by hand is miserable. So copying is the primary affordance —
 * and because a clipboard write can be refused (insecure context, permission
 * policy, an older WebKit), the refusal is shown rather than swallowed. The
 * writer is injected: tests need it, and so does any host that has its own.
 *
 * WHY THIS CONTROL IS SMALL AND QUIET.
 *
 * It used to be a full `kt-btn` with a 44px floor and a word beside the icon,
 * repeated under every block. Four of them on one screen read as four calls to
 * action, which is exactly the failure mode a screen full of near-identical
 * commands already has: everything looks equally important, so nothing does.
 * The rule on this screen is ONE loud control per step — `Next` — and every
 * other affordance stays out of the way until it is wanted. So copy is icon-led,
 * borderless until hover, and sized from `--copy-target` rather than the
 * theme's control floor.
 *
 * It is deliberately under the 44px touch minimum, which is a trade, not an
 * oversight: this is a shortcut for text that remains selectable by hand, it
 * carries a full accessible name, and it is never the only way to make progress.
 * A miss costs nothing. The one control that gates progress keeps the floor.
 */

import { Check, Copy, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

export type ClipboardWriter = (text: string) => Promise<void>;

/** The real clipboard, which rejects rather than pretending on a browser that has none. */
export const browserClipboardWriter =
  (): ClipboardWriter =>
  async (text: string): Promise<void> => {
    const clipboard = (globalThis.navigator as { clipboard?: { writeText?: (value: string) => Promise<void> } })
      ?.clipboard;
    if (typeof clipboard?.writeText !== 'function') {
      throw new Error('this browser will not give the page clipboard access');
    }
    await clipboard.writeText(text);
  };

type CopyState = 'idle' | 'copied' | 'failed';

const COPY_MESSAGE: Record<CopyState, string> = {
  idle: '',
  copied: 'Copied',
  failed: 'Copy was blocked — select the text instead',
};

/** 32px: smaller than a control, still comfortably bigger than the icon in it. */
const COPY_CONTROL =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-transparent bg-transparent text-faint transition-colors hover:border-border-strong hover:bg-surface hover:text-accent focus-visible:outline-focus focus-visible:outline-offset-focus';

const COPY_TONE: Record<CopyState, string> = {
  idle: '',
  copied: 'text-ok',
  failed: 'text-warn',
};

export interface CopyButtonProps {
  readonly text: string;
  /** The accessible name. Not rendered: the icon carries the meaning. */
  readonly label: string;
  readonly write: ClipboardWriter;
}

export function CopyButton({ text, label, write }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>('idle');
  // The promise is consumed here on purpose: an unhandled rejection would take
  // the whole page's error handling with it over a clipboard permission.
  const copy = (): void => {
    void write(text).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  };
  return (
    <>
      <button
        type="button"
        aria-label={label}
        className={`${COPY_CONTROL} ${COPY_TONE[state]}`}
        onClick={copy}
        data-onboarding-copy={label}
      >
        <CopyIcon state={state} />
      </button>
      {/*
        Present from first paint and empty until there is news: a live region
        added at the same moment it fills announces nothing at all. A success is
        announced but not written out — the tick already says it, in place, with
        no layout shift. A REFUSAL is different: nothing else on screen would
        tell the reader their clipboard is empty, so it gets words.
      */}
      <span
        role="status"
        className={state === 'failed' ? 'text-meta text-warn' : 'sr-only'}
        data-onboarding-copy-status={state}
      >
        {COPY_MESSAGE[state]}
      </span>
    </>
  );
}

/** State by shape as well as by colour, for a reader who cannot tell green from grey. */
function CopyIcon({ state }: { readonly state: CopyState }) {
  if (state === 'copied') return <Check size={16} aria-hidden="true" />;
  if (state === 'failed') return <TriangleAlert size={16} aria-hidden="true" />;
  return <Copy size={16} aria-hidden="true" />;
}
