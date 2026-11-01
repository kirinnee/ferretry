/**
 * "2 items skipped" under a runtime: a quiet line that opens the list of what the provisioner left as it
 * was and why. The paths are inside the runtime's folder (see `skipped-model.ts`); nothing here shows where
 * the folder is.
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { type SkippedItem, skippedCountLine } from '../shell/skipped-model.ts';

export function SkippedLine({ name, items }: { readonly name: string; readonly items: readonly SkippedItem[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (items.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="relative flex min-w-0 flex-col gap-1" data-runtime-skipped={name}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        className="inline-flex min-h-control w-fit items-center gap-1 rounded-control border-0 bg-transparent p-0 text-meta text-muted hover:text-fg"
        onClick={() => setOpen(value => !value)}
      >
        <Chevron size={14} aria-hidden="true" />
        {skippedCountLine(items.length)}
      </button>
      {open ? (
        <ul id={listId} className="m-0 flex list-none flex-col gap-1 p-0 pb-2 pl-5">
          {items.map(item => (
            <li key={item.within} className="text-meta leading-base text-muted">
              <code className="break-all font-mono text-fg">{item.within}</code>
              <span className="block">{item.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
