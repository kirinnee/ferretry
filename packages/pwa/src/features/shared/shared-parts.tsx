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

/**
 * A machine's ID: the start of its fingerprint, in full when tapped. It is how a person compares a
 * publisher, so it stays reachable; it is quiet text, not a box. A real button, so it works without a mouse.
 */
export function Fingerprint({
  head,
  full,
  label = 'Machine ID',
}: {
  readonly head: string;
  readonly full: string;
  readonly label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-1 text-meta text-muted">
      <span>{label}:</span>
      <button
        type="button"
        className="inline-flex min-h-[44px] max-w-full items-center break-all bg-transparent p-0 text-left font-mono text-meta text-fg underline decoration-dotted underline-offset-4 focus-visible:outline-focus focus-visible:outline-offset-focus"
        aria-expanded={open}
        aria-label={open ? `${label}, shown in full` : `${label}, start only. Tap for all of it`}
        onClick={() => setOpen(current => !current)}
        data-fingerprint=""
      >
        {open ? full : `${head}…`}
      </button>
    </p>
  );
}
