import { Fragment, type ReactNode } from 'react';

/**
 * Characters that change how text is laid out or that draw nothing: the bidirectional overrides and isolates (U+202A to
 * U+202E, U+2066 to U+2069), the zero-width and direction marks (U+200B to U+200F) and the byte-order mark (U+FEFF). In a
 * diff they are how a line is made to read differently from what it says, so each is drawn as a named chip, never passed on.
 */
const CONTROLS = /[‪-‮⁦-⁩​-‏﻿]/gu;

/** The label of one control character: `U+202E`. */
const controlLabel = (char: string): string =>
  `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;

export type TextPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'control'; readonly label: string };

/** `text` cut into the runs between its control characters and the controls themselves; one run when it has none. */
function textParts(text: string): readonly TextPart[] {
  const parts: TextPart[] = [];
  let from = 0;
  for (const match of text.matchAll(CONTROLS)) {
    if (match.index > from) parts.push({ kind: 'text', text: text.slice(from, match.index) });
    parts.push({ kind: 'control', label: controlLabel(match[0]) });
    from = match.index + match[0].length;
  }
  if (from < text.length || parts.length === 0) parts.push({ kind: 'text', text: text.slice(from) });
  return parts;
}

/** The marker drawn in place of a control character. Plain text inside: nothing here is markup. */
function ControlChip({ label }: { readonly label: string }) {
  return (
    <span
      className="mx-px rounded-sm bg-warn-bg px-0.5 text-meta text-warn"
      data-diff-control={label}
      title={`A hidden control character (${label}) is in this text`}
    >
      {`<${label}>`}
    </span>
  );
}

/** Text from a stranger with its control characters made visible; `render` draws each run of ordinary text. */
export function VisibleRuns({
  text,
  render = run => run,
}: {
  readonly text: string;
  readonly render?: (run: string) => ReactNode;
}) {
  return (
    <>
      {textParts(text).map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one string never reorder
        <Fragment key={index}>
          {part.kind === 'control' ? <ControlChip label={part.label} /> : render(part.text)}
        </Fragment>
      ))}
    </>
  );
}

/** As `VisibleRuns`, isolated from the surrounding direction so the text cannot reorder what sits beside it. */
export function VisibleText(props: { readonly text: string; readonly render?: (run: string) => ReactNode }) {
  return (
    <bdi>
      <VisibleRuns {...props} />
    </bdi>
  );
}
