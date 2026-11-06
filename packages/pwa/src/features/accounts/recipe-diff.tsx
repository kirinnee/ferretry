/**
 * A recipe change as lines: kept (` `), taken out (`-`) and put in (`+`). Plain text, never Markdown, so a ferret's
 * words load no image and show no link. Settings and the recipe card on the agenda draw the SAME diff.
 */

import { recipeDiff } from '@ferretry/protocol';
import type { ReactNode } from 'react';

const DIFF_TONE = { ' ': 'text-muted', '-': 'bg-err-bg text-err', '+': 'bg-ok-bg text-ok' } as const;

export interface RecipeDiffProps {
  /** The recipe the change was made against; absent when there was none. */
  readonly base?: string | undefined;
  readonly recipe: string;
}

export function RecipeDiff({ base, recipe }: RecipeDiffProps): ReactNode {
  return (
    <pre
      className="mono m-0 min-w-0 whitespace-pre-wrap break-words rounded-control border border-border p-0 text-meta"
      data-accounts-diff=""
    >
      {recipeDiff(base, recipe).map((line, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff line has no identity beyond its place
          key={index}
          className={`block px-2 ${DIFF_TONE[line.op]}`}
          data-diff-op={line.op}
        >
          {line.op === ' ' ? '  ' : `${line.op} `}
          {line.text}
        </span>
      ))}
    </pre>
  );
}
