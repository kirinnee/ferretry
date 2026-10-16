/** The unified diff an Apply will write, read line by line in the theme's add/remove tones. */

import { FileText } from 'lucide-react';
import { cn } from '../../lib/class-names.ts';
import { basename, type DiffLineKind, diffLines, diffSummary } from './learning-model.ts';

const LINE_CLASS: Readonly<Record<DiffLineKind, string>> = {
  add: 'bg-ok-bg text-ok',
  remove: 'bg-err-bg text-err',
  hunk: 'text-accent',
  meta: 'text-faint',
  context: 'text-fg-soft',
};

export function ApplyDiff({ path, diff }: { readonly path: string; readonly diff: string }) {
  return (
    <figure className="m-0 min-w-0 overflow-hidden rounded-control border border-border-soft bg-surface-1">
      <figcaption className="flex min-w-0 items-center gap-2 border-b border-border-soft px-3 py-1.5 text-meta">
        <FileText size={13} aria-hidden="true" className="shrink-0 text-faint" />
        <span className="mono min-w-0 truncate text-fg-soft" title={path}>
          {basename(path)}
        </span>
        <span className="ml-auto shrink-0 text-faint">{diffSummary(diff)}</span>
      </figcaption>
      {/* The only box here allowed to be wider than the screen: a long line scrolls inside it. */}
      <div className="max-h-[320px] overflow-auto" data-learning-diff="">
        <pre className="mono m-0 w-max min-w-full py-1 text-meta leading-base">
          {diffLines(diff).map((line, index) => (
            <span
              // A diff can repeat a line verbatim; its position is its identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no other identity
              key={index}
              className={cn('block px-3', LINE_CLASS[line.kind])}
              data-diff-line={line.kind}
            >
              {line.text === '' ? ' ' : line.text}
            </span>
          ))}
        </pre>
      </div>
    </figure>
  );
}
