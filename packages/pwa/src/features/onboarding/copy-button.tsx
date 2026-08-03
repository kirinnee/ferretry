/**
 * One-tap copy, and an honest answer when it does not work.
 *
 * Every command on the setup screen has to leave this page and land in a
 * terminal, usually on a different machine, often on a phone where selecting
 * monospace text by hand is miserable. So copying is the primary affordance —
 * and because a clipboard write can be refused (insecure context, permission
 * policy, an older WebKit), the refusal is shown rather than swallowed. The
 * writer is injected: tests need it, and so does any host that has its own.
 */

import { Check, Copy } from 'lucide-react';
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

export interface CopyButtonProps {
  readonly text: string;
  /** The visible button label, which is also its accessible name. */
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
    <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
      <button type="button" className="kt-btn min-h-[44px]" onClick={copy} data-onboarding-copy={label}>
        {state === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        {label}
      </button>
      {/*
        Present from first paint and empty until there is news: a live region
        added at the same moment it fills announces nothing at all.
      */}
      <span
        role="status"
        className={state === 'failed' ? 'text-meta text-warn' : 'text-meta text-muted'}
        data-onboarding-copy-status={state}
      >
        {COPY_MESSAGE[state]}
      </span>
    </span>
  );
}

export interface CommandBlockProps {
  /** Exactly what the reader must run — never a paraphrase. */
  readonly command: string;
  /** Names the block for the copy control, e.g. `Copy install commands`. */
  readonly copyLabel: string;
  readonly write: ClipboardWriter;
}

/**
 * A copyable command block.
 *
 * `overflow-x-auto` is paired with `overflow-y-hidden` deliberately: on its own
 * it grows a phantom vertical scrollbar inside the box, which the original UI
 * hit and fixed the same way.
 */
export function CommandBlock({ command, copyLabel, write }: CommandBlockProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface-2 p-2">
      <pre className="m-0 overflow-x-auto overflow-y-hidden font-mono text-meta leading-base text-fg">
        <code>{command}</code>
      </pre>
      <CopyButton text={command} label={copyLabel} write={write} />
    </div>
  );
}
