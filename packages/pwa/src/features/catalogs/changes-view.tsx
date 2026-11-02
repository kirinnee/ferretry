/**
 * "What changed" between two versions of a catalog item, in the style of the Apply diff.
 *
 * The daemon compared the review text a person reads, which already marks hidden characters, and wrote a
 * carriage return at the end of a line as `⟨U+000D⟩`. Everything here goes through {@link MarkedText}, so no text
 * is ever drawn raw. Entries that deserve a second look (a command, a script, a file a tool runs on its own) and
 * warnings the later version adds come first, and a file too big to compare says so in words.
 */

import type { CatalogChange, CatalogChanges } from '@ferretry/protocol';
import { cn } from '../../lib/class-names.ts';
import { MarkedText, WarningList } from './catalog-review-view.tsx';
import {
  changeLabel,
  changesSummary,
  flagLabel,
  hunkHeader,
  LINE_SIGN,
  TOO_LARGE_SENTENCE,
  TRUNCATED_SENTENCE,
} from './versions-model.ts';

type Kind = keyof typeof LINE_SIGN;

const LINE_CLASS: Readonly<Record<Kind, string>> = {
  add: 'bg-ok-bg text-ok',
  remove: 'bg-err-bg text-err',
  context: 'text-fg-soft',
};

function DiffLine({ kind, text }: { readonly kind: Kind; readonly text: string }) {
  return (
    <span className={cn('block whitespace-pre-wrap break-words px-3', LINE_CLASS[kind])} data-change-line={kind}>
      <span aria-hidden="true" className="select-none pr-2">
        {LINE_SIGN[kind]}
      </span>
      <MarkedText text={text} />
    </span>
  );
}

/** A whole text added or removed, line by line, so the sign shows on every line. */
function WholeText({ kind, text }: { readonly kind: 'add' | 'remove'; readonly text: string }) {
  return (
    <>
      {text.split('\n').map((line, index) => (
        // A text can repeat a line verbatim; its position is its identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no other identity
        <DiffLine key={index} kind={kind} text={line} />
      ))}
    </>
  );
}

function EntryBody({ entry }: { readonly entry: CatalogChange }) {
  if (entry.tooLarge === true)
    return (
      <p className="m-0 px-3 py-2 text-cell text-muted" data-change-too-large="">
        {TOO_LARGE_SENTENCE}
      </p>
    );
  if (entry.hunks !== undefined)
    return (
      <>
        {entry.hunks.map(hunk => (
          <div key={`${String(hunk.beforeStart)}:${String(hunk.afterStart)}`} data-change-hunk="">
            <span className="block px-3 text-accent">{hunkHeader(hunk)}</span>
            {hunk.lines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no other identity
              <DiffLine key={index} kind={line.kind} text={line.text} />
            ))}
          </div>
        ))}
      </>
    );
  return (
    <>
      {entry.before === undefined ? null : <WholeText kind="remove" text={entry.before} />}
      {entry.after === undefined ? null : <WholeText kind="add" text={entry.after} />}
    </>
  );
}

function Entry({ entry }: { readonly entry: CatalogChange }) {
  return (
    <figure
      className={cn(
        'm-0 min-w-0 overflow-hidden rounded-control border bg-surface',
        entry.flag === undefined ? 'border-border-soft' : 'border-warn-border',
      )}
      data-change-entry={entry.label}
      data-change-kind={entry.change}
      {...(entry.flag === undefined ? {} : { 'data-change-flag': entry.flag })}
    >
      <figcaption className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-soft px-3 py-1.5 text-meta">
        <span className="min-w-0 break-all font-semibold text-fg">
          <MarkedText text={entry.label} />
        </span>
        <span className="fy-info-chip" data-tone="muted">
          {changeLabel(entry.change)}
        </span>
        {entry.flag === undefined ? null : (
          <span className="fy-info-chip" data-tone="caution">
            {flagLabel(entry.flag)}
          </span>
        )}
      </figcaption>
      {/* The only box here allowed to be wider than the screen: a long line scrolls inside it. */}
      <div className="max-h-[320px] overflow-auto">
        <pre className="mono m-0 w-max min-w-full max-w-none py-1 text-meta leading-base">
          <EntryBody entry={entry} />
        </pre>
      </div>
    </figure>
  );
}

export function ChangesView({
  changes,
  heading = 'What changed',
}: {
  readonly changes: CatalogChanges;
  readonly heading?: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-xs" aria-label={heading} data-changes-view="">
      <h4 className="m-0 text-meta font-semibold uppercase text-muted">{heading}</h4>
      <p className="m-0 text-cell text-fg" data-changes-summary="">
        {changesSummary(changes)}
      </p>
      {changes.newWarnings.length === 0 ? null : (
        <div className="flex min-w-0 flex-col gap-xs" data-changes-new-warnings="">
          <p className="m-0 text-cell font-semibold text-fg">New warnings in this version</p>
          <WarningList warnings={changes.newWarnings} />
        </div>
      )}
      {changes.goneWarnings.length === 0 ? null : (
        <div className="flex min-w-0 flex-col gap-xs" data-changes-gone-warnings="">
          <p className="m-0 text-cell font-semibold text-fg">Warnings this version no longer has</p>
          <WarningList warnings={changes.goneWarnings} />
        </div>
      )}
      {changes.truncated === true ? (
        <p className="m-0 text-cell text-muted" role="status" data-changes-truncated="">
          {TRUNCATED_SENTENCE}
        </p>
      ) : null}
      {changes.entries.map(entry => (
        <Entry key={`${entry.change}:${entry.label}`} entry={entry} />
      ))}
    </section>
  );
}
