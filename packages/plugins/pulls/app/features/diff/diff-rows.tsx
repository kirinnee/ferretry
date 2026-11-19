import { highlightToHtml } from '@ferretry/app';
import { trustedHighlight } from '@ferretry/app/ui';
import { memo, type ReactNode, useMemo } from 'react';
import { type DiffHunk, type DiffLine, type DiffSide, splitRows } from '../../../contract/diff-hunks.ts';

/** Where a line sits, for a thread drawn under it (E6): its file, the side it is on and its number on that side. */
export interface LineAt {
  readonly path: string;
  readonly side: DiffSide;
  readonly line: number;
}
/** Draws something under a line (review threads). Returns nothing for a line that has none. */
export type LineExtras = (at: LineAt) => ReactNode;

const MARK = { add: '+', del: '−', context: ' ' } as const;
const TONE = {
  add: 'bg-ok-bg text-fg',
  del: 'bg-err-bg text-fg',
  context: 'text-fg',
} as const;
const NUMBER_TONE = { add: 'text-ok', del: 'text-err', context: 'text-faint' } as const;

/**
 * One line's text. A language the app's highlighter knows is coloured by it, line by line; anything else is the plain
 * escaped text. The highlighter's own contract is what makes the markup safe (it escapes what it tokenizes), the same one
 * the transcript's code blocks rely on; a stranger's text is never forwarded as markup on either path.
 */
const Code = memo(function Code({ text, lang }: { readonly text: string; readonly lang: string | undefined }) {
  const html = useMemo(() => highlightToHtml(text, lang), [text, lang]);
  if (html === null) return <>{text === '' ? '​' : text}</>;
  // biome-ignore lint/security/noDangerouslySetInnerHtml: the highlighter's own escaped markup (see above)
  return <span dangerouslySetInnerHTML={{ __html: trustedHighlight(html) }} />;
});

const lineAt = (path: string, line: DiffLine): LineAt | undefined =>
  line.newLine !== undefined
    ? { path, side: 'right', line: line.newLine }
    : line.oldLine === undefined
      ? undefined
      : { path, side: 'left', line: line.oldLine };

function Extras({ at, extras }: { readonly at: LineAt | undefined; readonly extras: LineExtras | undefined }) {
  const node = at === undefined || extras === undefined ? null : extras(at);
  return node === null || node === undefined || node === false ? null : <div className="col-span-full">{node}</div>;
}

const Gutter = ({ n, tone }: { readonly n: number | undefined; readonly tone: keyof typeof NUMBER_TONE }) => (
  <span
    aria-hidden="true"
    className={`select-none px-1.5 text-right text-meta tabular-nums ${NUMBER_TONE[tone]}`}
    data-gutter={n ?? ''}
  >
    {n ?? ''}
  </span>
);

function HunkHeader({ hunk }: { readonly hunk: DiffHunk }) {
  return (
    <div className="col-span-full truncate bg-code-bg px-2 py-0.5 text-meta text-faint" data-diff-hunk={hunk.header}>
      {hunk.header}
    </div>
  );
}

/** The one-column view: removed and added lines stacked, with both line numbers. The only view below 1024 px. */
export function UnifiedHunk({
  hunk,
  path,
  lang,
  extras,
}: {
  readonly hunk: DiffHunk;
  readonly path: string;
  readonly lang: string | undefined;
  readonly extras?: LineExtras | undefined;
}) {
  return (
    <div className="grid grid-cols-[3rem_3rem_minmax(0,1fr)] font-mono text-code leading-base" data-diff-view="unified">
      <HunkHeader hunk={hunk} />
      {hunk.lines.map(line => {
        const at = lineAt(path, line);
        return (
          <div
            className={`col-span-full grid grid-cols-subgrid ${TONE[line.kind]}`}
            data-diff-line={line.kind}
            data-diff-path={path}
            data-diff-side={at?.side}
            data-diff-number={at?.line}
            key={`${line.oldLine ?? '_'}:${line.newLine ?? '_'}:${line.kind}`}
          >
            <Gutter n={line.oldLine} tone={line.kind} />
            <Gutter n={line.newLine} tone={line.kind} />
            <span className="min-w-0 whitespace-pre-wrap break-words px-2">
              <span aria-hidden="true" className={`select-none pr-1 ${NUMBER_TONE[line.kind]}`}>
                {MARK[line.kind]}
              </span>
              <Code lang={lang} text={line.text} />
              {line.noNewline === true ? (
                <span className="pl-2 text-meta text-faint">no newline at end of file</span>
              ) : null}
            </span>
            <Extras at={at} extras={extras} />
          </div>
        );
      })}
    </div>
  );
}

function Half({
  line,
  side,
  path,
  lang,
}: {
  readonly line: DiffLine | undefined;
  readonly side: DiffSide;
  readonly path: string;
  readonly lang: string | undefined;
}) {
  if (line === undefined)
    return (
      <>
        <span aria-hidden="true" className="bg-code-bg" />
        <span aria-hidden="true" className="bg-code-bg" />
      </>
    );
  const n = side === 'left' ? line.oldLine : line.newLine;
  // A context line is the same on both sides; only a changed line takes its colour on its own side.
  const tone = line.kind;
  return (
    <>
      <span className={TONE[tone]}>
        <Gutter n={n} tone={tone} />
      </span>
      <span
        className={`min-w-0 whitespace-pre-wrap break-words px-2 ${TONE[tone]}`}
        data-diff-line={tone}
        data-diff-number={n}
        data-diff-path={path}
        data-diff-side={side}
      >
        <Code lang={lang} text={line.text} />
        {line.noNewline === true ? <span className="pl-2 text-meta text-faint">no newline at end of file</span> : null}
      </span>
    </>
  );
}

/** The two-column view (from 1024 px): the old file on the left, the new on the right, changed lines side by side. */
export function SplitHunk({
  hunk,
  path,
  lang,
  extras,
}: {
  readonly hunk: DiffHunk;
  readonly path: string;
  readonly lang: string | undefined;
  readonly extras?: LineExtras | undefined;
}) {
  const rows = useMemo(() => splitRows(hunk), [hunk]);
  return (
    <div
      className="grid grid-cols-[3rem_minmax(0,1fr)_3rem_minmax(0,1fr)] font-mono text-code leading-base"
      data-diff-view="split"
    >
      <HunkHeader hunk={hunk} />
      {rows.map((row, index) => {
        const left = row.left;
        const right = row.right;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are derived from the hunk and never reorder
          <div className="col-span-full grid grid-cols-subgrid" key={index}>
            <Half line={left} lang={lang} path={path} side="left" />
            <Half line={right} lang={lang} path={path} side="right" />
            {left?.kind === 'del' && left.oldLine !== undefined ? (
              <Extras at={{ path, side: 'left', line: left.oldLine }} extras={extras} />
            ) : null}
            {right?.newLine === undefined ? null : (
              <Extras at={{ path, side: 'right', line: right.newLine }} extras={extras} />
            )}
          </div>
        );
      })}
    </div>
  );
}
