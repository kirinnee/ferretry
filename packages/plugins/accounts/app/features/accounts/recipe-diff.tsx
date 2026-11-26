/**
 * The lines a proposed recipe changes, kept, removed or added, drawn as plain text (never Markdown: a recipe a ferret wrote must
 * not load an image or show a link unlike its target). One component for Settings › Recipe and for the ask card, so the owner
 * reads the same change in both. The panel's own padding keeps every line clear of a rounded corner.
 */

import type { ReactNode } from 'react';
import { recipeDiff } from '../../../contract/routes/index.ts';

const DIFF_TONE = { ' ': 'text-muted', '-': 'bg-err-bg text-err', '+': 'bg-ok-bg text-ok' } as const;

export function RecipeDiff({
  base,
  recipe,
}: {
  readonly base: string | undefined;
  readonly recipe: string;
}): ReactNode {
  return (
    <pre
      className="mono m-0 min-w-0 whitespace-pre-wrap break-words rounded-panel border border-border p-panel text-meta"
      data-accounts-diff=""
    >
      {recipeDiff(base, recipe).map((line, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff line has no identity beyond its place
          key={index}
          className={`block px-1 ${DIFF_TONE[line.op]}`}
          data-diff-op={line.op}
        >
          {line.op === ' ' ? '  ' : `${line.op} `}
          {line.text}
        </span>
      ))}
    </pre>
  );
}
