/**
 * The review of one catalog item, drawn the same way for the publisher and the installer.
 *
 * Every file is here in full, every command line and variable is here, and every warning is said in
 * words beside an icon. The daemon wrote all of it; this only lays it out. Hidden-character markers
 * stand out and are never removed.
 */

import type { CatalogInstallWarning, CatalogReviewEntry } from '@ferretry/protocol';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/class-names.ts';
import {
  INSTALLER_FILLS_IN,
  type ReviewRow,
  reviewHeading,
  reviewRows,
  splitMarkers,
  type WarningRow,
  type WarningTone,
  warningRows,
} from './catalog-review-model.ts';

const TONE_CLASS: Readonly<Record<WarningTone, string>> = {
  danger: 'border-err-border bg-err-bg text-err',
  caution: 'border-warn-border bg-warn-bg text-warn',
  note: 'border-border-strong bg-surface-2 text-muted',
};

const TONE_ICON: Readonly<Record<WarningTone, typeof CircleAlert>> = {
  danger: CircleAlert,
  caution: TriangleAlert,
  note: Info,
};

/** Text with each hidden-character marker drawn on its own. Nothing is dropped. */
export function MarkedText({ text }: { readonly text: string }) {
  return (
    <>
      {splitMarkers(text).map((segment, index) =>
        segment.marker ? (
          <mark
            // The position is the identity: segments never reorder.
            // biome-ignore lint/suspicious/noArrayIndexKey: segments of one string
            key={index}
            className="rounded-control border border-err-border bg-err-bg px-1 font-semibold text-err"
            data-hidden-marker=""
          >
            {segment.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one string
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function FileBlock({ row, open }: { readonly row: Extract<ReviewRow, { kind: 'file' }>; readonly open: boolean }) {
  return (
    <details className="kt-panel min-w-0" open={open || row.marked} data-review-file={row.path}>
      <summary className="flex min-h-[44px] cursor-pointer select-none flex-wrap items-center gap-x-sm gap-y-xs px-control-x py-2 text-cell">
        <span className="min-w-0 flex-1 break-all font-mono text-fg">{row.path}</span>
        <span className="text-meta text-faint">{row.lines === 1 ? '1 line' : `${row.lines} lines`}</span>
        {row.marked ? (
          <span className="fy-info-chip" data-tone="danger">
            Has hidden characters
          </span>
        ) : null}
      </summary>
      <pre className="m-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words border-t border-border-soft p-control-x font-mono text-2xs leading-base text-fg">
        <MarkedText text={row.text} />
      </pre>
    </details>
  );
}

function LineBlock({
  row,
  installerView,
}: {
  readonly row: Extract<ReviewRow, { kind: 'line' }>;
  readonly installerView: boolean;
}) {
  const shown = installerView && row.placeholder !== undefined ? INSTALLER_FILLS_IN : row.text;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-b border-border-soft py-xs" data-review-line={row.label}>
      <span className="text-meta font-semibold text-muted">{row.label}</span>
      <span
        className={cn(
          'break-words font-mono text-cell text-fg',
          row.placeholder !== undefined && installerView && 'font-sans',
        )}
      >
        <MarkedText text={shown} />
      </span>
    </div>
  );
}

/**
 * Files and lines, in the order the daemon gave them.
 *
 * `installerView` is for the publisher's sheet: a `${secret:NAME}` value is shown as the sentence that
 * says the installer fills in their own. The installer sees every entry exactly as written.
 */
export function ReviewBody({
  entries,
  installerView = false,
}: {
  readonly entries: readonly CatalogReviewEntry[];
  readonly installerView?: boolean;
}) {
  const rows = reviewRows(entries).map((row, position) => ({ row, key: `${position}:${row.kind}` }));
  return (
    <section className="flex min-w-0 flex-col gap-xs" aria-label="What is in it" data-review-body="">
      <h4 className="m-0 text-meta font-semibold uppercase text-muted">
        {reviewHeading(rows.map(entry => entry.row))}
      </h4>
      {rows.map(({ row, key }, index) =>
        row.kind === 'file' ? (
          <FileBlock key={key} row={row} open={index === 0} />
        ) : (
          <LineBlock key={key} row={row} installerView={installerView} />
        ),
      )}
    </section>
  );
}

function WarningItem({ row }: { readonly row: WarningRow }) {
  const Icon = TONE_ICON[row.tone];
  return (
    <li
      className={cn('flex min-w-0 items-start gap-2 rounded-control border p-control-x py-2', TONE_CLASS[row.tone])}
      data-warning={row.code}
      data-warning-tone={row.tone}
    >
      <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-cell font-semibold">{row.label}</span>
        <span className="break-words text-cell">{row.text}</span>
      </span>
    </li>
  );
}

/** Every warning, the most serious first. Said in words with an icon, never by colour alone. */
export function WarningList({ warnings }: { readonly warnings: readonly CatalogInstallWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label="Warnings" data-review-warnings="">
      {warningRows(warnings).map(row => (
        <WarningItem key={`${row.code}:${row.text}`} row={row} />
      ))}
    </ul>
  );
}
