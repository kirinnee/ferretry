/**
 * A LEAD'S VIEW OF ITS PACK — the helpers a ferret started, seen from the lead (docs/pack-mode.md).
 *
 * The child already says "Started by <lead>". This is the other direction: the panel beside a ferret lists the ACTIVE
 * helpers, and a finished one sits behind "Show finished (n)" so a long-running lead's history cannot flood it. Each row is
 * the helper's name as a link, how it is doing now — with the reason when it needs you or has ended — and the model it runs
 * on (`lib/helper-state.ts`).
 *
 * The rows are live because the pack table they come from is: the panel re-reads it, and nothing here keeps a copy.
 */

import { useState } from 'react';
import type { PackRow } from '../../contract/index.ts';
import { type HelperReading, helperLive, helperModel, helperName, helperState } from '../lib/helper-state.ts';

/** One helper as a row shows it. */
export interface HelperItem {
  readonly id: string;
  readonly name: string;
  readonly reading: HelperReading;
  readonly model?: string;
  /** Goes to it. Absent: this host cannot navigate, and the name is plain text. */
  readonly onOpen?: () => void;
}

/** The rows for `rows`, each opening through `open` when the host can navigate. */
export const helperItems = (rows: readonly PackRow[], open?: (ferretId: string) => void): readonly HelperItem[] =>
  rows.map(row => {
    const model = helperModel(row);
    return {
      id: row.id,
      name: helperName(row),
      reading: helperState(row),
      ...(model === '' ? {} : { model }),
      ...(open === undefined ? {} : { onOpen: () => open(row.id) }),
    };
  });

/** A small dot and a word for how a helper is doing, and why when there is a reason. */
export function HelperStateLabel({ reading }: { readonly reading: HelperReading }) {
  return (
    <span className="fy-helper-state" data-helper-state={reading.state}>
      <span aria-hidden="true" className="fy-helper-dot" />
      <span>{reading.word}</span>
      {reading.reason === undefined ? null : <span className="fy-helper-reason"> — {reading.reason}</span>}
    </span>
  );
}

/** One helper: name (a link when it can open), state and model. */
function HelperRow({ item }: { readonly item: HelperItem }) {
  return (
    <li className="fy-helper-row" data-helper={item.id}>
      {item.onOpen === undefined ? (
        <span className="fy-helper-name">{item.name}</span>
      ) : (
        <button
          className="fy-helper-name fy-helper-link"
          data-helper-open={item.id}
          onClick={item.onOpen}
          type="button"
        >
          {item.name}
        </button>
      )}
      <HelperStateLabel reading={item.reading} />
      {item.model === undefined ? null : <span className="fy-helper-model">{item.model}</span>}
    </li>
  );
}

/** The helpers still at work: starting, working, waiting or waiting on you. */
const activeHelpers = (rows: readonly PackRow[]): readonly PackRow[] =>
  rows.filter(row => helperLive(helperState(row)));

export function HelperList({ items }: { readonly items: readonly HelperItem[] }) {
  return (
    <ul className="fy-helper-list" data-helper-list="">
      {items.map(item => (
        <HelperRow item={item} key={item.id} />
      ))}
    </ul>
  );
}

/**
 * The lead's helpers: the active ones as a list, and the finished ones behind a "Show finished (n)" toggle. `rows` is every
 * helper, as `helpersOf` lists them.
 */
export function HelpersPack({
  rows,
  onOpenFerret,
}: {
  readonly rows: readonly PackRow[];
  readonly onOpenFerret?: (ferretId: string) => void;
}) {
  const [showFinished, setShowFinished] = useState(false);
  const active = activeHelpers(rows);
  const finished = rows.filter(row => !active.includes(row));
  return (
    <div className="fy-helper-pack" data-helper-pack="">
      {active.length === 0 ? <span className="fy-info-muted">None active</span> : null}
      {active.length === 0 ? null : <HelperList items={helperItems(active, onOpenFerret)} />}
      {finished.length === 0 ? null : (
        <>
          <button
            aria-expanded={showFinished}
            className="fy-helper-finished-toggle"
            data-helper-finished-toggle=""
            onClick={() => setShowFinished(current => !current)}
            type="button"
          >
            {showFinished ? 'Hide' : 'Show'} finished ({finished.length})
          </button>
          {showFinished ? <HelperList items={helperItems(finished, onOpenFerret)} /> : null}
        </>
      )}
    </div>
  );
}
