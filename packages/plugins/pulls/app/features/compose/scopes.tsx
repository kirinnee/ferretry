import { Button } from '@ferretry/app/ui';
import { type ReactNode, useCallback } from 'react';
import { useMaybeCompose } from './context.tsx';
import type { DiffRange } from './quote.ts';
import { SelectionScope } from './selection-scope.tsx';

const elementOf = (node: Node | null): Element | null =>
  node instanceof Element ? node : (node?.parentElement ?? null);

/** The closest ancestor matching `selector` that is INSIDE `root` (an element outside the region never counts). */
const within = (root: HTMLElement, node: Node | null, selector: string): HTMLElement | undefined => {
  const found = elementOf(node)?.closest<HTMLElement>(selector);
  return found !== null && found !== undefined && root.contains(found) ? found : undefined;
};

/**
 * Text the person selected in GitHub's words (a description, a comment, a review): both ends of the selection must be
 * inside such a text, so a heading or a button is never quoted by accident.
 */
const readProse = (root: HTMLElement, selection: Selection): { readonly text: string } | undefined => {
  const range = selection.getRangeAt(0);
  if (!within(root, range.startContainer, '[data-gh-text]') || !within(root, range.endContainer, '[data-gh-text]'))
    return undefined;
  const text = selection.toString();
  return text.trim() === '' ? undefined : { text };
};

/** Wraps the conversation: a selection in its texts offers **Quote**. Without a PR page around it, it is only a wrapper. */
export function QuoteScope({ children }: { readonly children: ReactNode }) {
  const compose = useMaybeCompose();
  const quote = compose?.quote;
  const actions = useCallback(
    (found: { readonly text: string }, done: () => void) => (
      <Button
        onClick={() => {
          quote?.(found.text);
          done();
        }}
        size="sm"
        type="button"
      >
        Quote
      </Button>
    ),
    [quote],
  );
  if (compose === undefined) return <>{children}</>;
  return (
    <SelectionScope actions={actions} name="prose" read={readProse}>
      {children}
    </SelectionScope>
  );
}

interface DiffFound {
  readonly text: string;
  /** Set when the selection is lines of one file on one side: only then can it be commented on. */
  readonly range: DiffRange | undefined;
}

const lineOf = (
  element: HTMLElement | undefined,
): { readonly path: string; readonly side: 'left' | 'right'; readonly number: number } | undefined => {
  const number = Number(element?.dataset.diffNumber);
  const side = element?.dataset.diffSide;
  const path = element?.dataset.diffPath;
  if (!Number.isSafeInteger(number) || number < 1 || path === undefined) return undefined;
  if (side !== 'left' && side !== 'right') return undefined;
  return { path, side, number };
};

/** Diff lines the person selected: the text, and the lines when both ends are on the same file and side. */
const readDiff = (root: HTMLElement, selection: Selection): DiffFound | undefined => {
  const range = selection.getRangeAt(0);
  const start = within(root, range.startContainer, '[data-diff-line]');
  const end = within(root, range.endContainer, '[data-diff-line]');
  if (start === undefined || end === undefined) return undefined;
  // A thread or a reply box drawn under a line is not the line.
  if (
    within(root, range.startContainer, '[data-compose-extras]') ||
    within(root, range.endContainer, '[data-compose-extras]')
  )
    return undefined;
  const text = selection.toString();
  if (text.trim() === '') return undefined;
  const first = lineOf(start);
  const last = lineOf(end);
  if (first === undefined || last === undefined || first.path !== last.path || first.side !== last.side)
    return { text, range: undefined };
  return {
    text,
    range: {
      path: first.path,
      side: first.side,
      startLine: Math.min(first.number, last.number),
      line: Math.max(first.number, last.number),
    },
  };
};

/** Wraps the Files tab: a selection of diff lines offers **Quote**, and **Comment on these lines** when they can be. */
export function DiffSelectionScope({ children }: { readonly children: ReactNode }) {
  const compose = useMaybeCompose();
  const actions = useCallback(
    (found: DiffFound, done: () => void) => (
      <>
        <Button
          onClick={() => {
            compose?.quote(found.text, found.range);
            done();
          }}
          size="sm"
          type="button"
        >
          Quote
        </Button>
        {found.range !== undefined && (
          <Button
            onClick={() => {
              const range = found.range;
              if (range !== undefined && compose?.commentOnLines(range) === true) done();
            }}
            size="sm"
            type="button"
          >
            Comment on these lines
          </Button>
        )}
      </>
    ),
    [compose],
  );
  if (compose === undefined) return <>{children}</>;
  return (
    <SelectionScope actions={actions} name="diff" read={readDiff}>
      {children}
    </SelectionScope>
  );
}
