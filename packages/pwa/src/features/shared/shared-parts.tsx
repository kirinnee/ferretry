/** Small pieces the member's screens share: the page frame and the fingerprint that opens when tapped. */

import { type ReactNode, useState } from 'react';
import { cn } from '../../lib/class-names.ts';

/** One screen: a heading, then lines of one idea each. */
export function SharedPage({
  title,
  children,
  flush = false,
}: {
  readonly title: string;
  readonly children: ReactNode;
  /** No frame padding: the caller sits inside a layout that has its own. */
  readonly flush?: boolean;
}) {
  return (
    <main
      className={cn('mx-auto flex w-full min-w-0 max-w-[680px] flex-col gap-sm', flush ? '' : 'px-3 py-4')}
      data-shared-page=""
    >
      <h1 className="m-0 break-words font-display text-display font-bold tracking-display text-fg">{title}</h1>
      {children}
    </main>
  );
}

/** The start of a fingerprint to compare, in full when tapped. A real button, so it works without a mouse. */
export function Fingerprint({ head, full }: { readonly head: string; readonly full: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className="min-h-[44px] max-w-full break-all rounded-control border border-border bg-surface-2 px-2 text-left font-mono text-meta text-fg focus-visible:outline-focus focus-visible:outline-offset-focus"
      aria-expanded={open}
      aria-label={open ? 'Fingerprint, shown in full' : 'Fingerprint, start only. Tap for all of it'}
      onClick={() => setOpen(current => !current)}
      data-fingerprint=""
    >
      {open ? full : `${head}…`}
    </button>
  );
}
