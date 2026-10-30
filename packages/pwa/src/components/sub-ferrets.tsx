/**
 * A PARENT'S VIEW OF ITS PACK — the sub-ferrets a ferret started, seen from the parent (docs/pack-mode.md).
 *
 * The child already says "Started by <parent>". This is the other direction: Info's "About this ferret"
 * block lists the ACTIVE pack, and a finished, stopped or failed sub-ferret sits behind "Show finished (n)"
 * so a long-running parent's history cannot flood it. The session bar draws no indicator at all. Each row
 * is the sub-ferret's name as a link, how it is doing now — with the reason when it failed, stopped or
 * wants you — and the model it runs on (`lib/sub-ferret-state.ts`).
 *
 * The rows are live because the session list they come from is: the page re-reads it, and nothing here
 * keeps a copy.
 */

import type { SessionView } from '@ferretry/protocol';
import { useState } from 'react';
import {
  type SubFerretReading,
  subFerretLive,
  subFerretModel,
  subFerretName,
  subFerretState,
} from '../lib/sub-ferret-state.ts';

/** One sub-ferret as a row shows it. */
export interface SubFerretItem {
  readonly id: string;
  readonly name: string;
  readonly reading: SubFerretReading;
  readonly model?: string;
  /** Goes to it. Absent: this host cannot navigate, and the name is plain text. */
  readonly onOpen?: () => void;
}

/** The rows for `children`, each opening through `open` when the host can navigate. */
export const subFerretItems = (
  children: readonly SessionView[],
  open?: (sessionId: string) => void,
): readonly SubFerretItem[] =>
  children.map(view => {
    const model = subFerretModel(view);
    return {
      id: view.config.id,
      name: subFerretName(view),
      reading: subFerretState(view),
      ...(model === undefined ? {} : { model }),
      ...(open === undefined ? {} : { onOpen: () => open(view.config.id) }),
    };
  });

/** A small dot and a word for how a sub-ferret is doing, and why when there is a reason. */
export function SubFerretStateLabel({ reading }: { readonly reading: SubFerretReading }) {
  return (
    <span className="fy-sub-ferret-state" data-sub-ferret-state={reading.state}>
      <span aria-hidden="true" className="fy-sub-ferret-dot" />
      <span>{reading.word}</span>
      {reading.reason === undefined ? null : <span className="fy-sub-ferret-reason"> — {reading.reason}</span>}
    </span>
  );
}

/** One sub-ferret: name (a link when it can open), state and model. */
export function SubFerretRow({ item }: { readonly item: SubFerretItem }) {
  return (
    <li className="fy-sub-ferret-row" data-sub-ferret={item.id}>
      {item.onOpen === undefined ? (
        <span className="fy-sub-ferret-name">{item.name}</span>
      ) : (
        <button
          className="fy-sub-ferret-name fy-sub-ferret-link"
          data-sub-ferret-open={item.id}
          onClick={item.onOpen}
          type="button"
        >
          {item.name}
        </button>
      )}
      <SubFerretStateLabel reading={item.reading} />
      {item.model === undefined ? null : <span className="fy-sub-ferret-model">{item.model}</span>}
    </li>
  );
}

/** The sub-ferrets still at work: starting, working, at their prompt or waiting on you. */
export const activeSubFerrets = (children: readonly SessionView[]): readonly SessionView[] =>
  children.filter(view => subFerretLive(subFerretState(view)));

export function SubFerretList({ items }: { readonly items: readonly SubFerretItem[] }) {
  return (
    <ul className="fy-sub-ferret-list" data-sub-ferret-list="">
      {items.map(item => (
        <SubFerretRow item={item} key={item.id} />
      ))}
    </ul>
  );
}

/**
 * Info's sub-ferrets: the active ones as a list, and the finished ones (done, stopped, failed) behind a
 * "Show finished (n)" toggle. `sessions` is every sub-ferret, as `subFerretsOf` lists them.
 */
export function SubFerretsPack({
  sessions,
  onOpenSession,
}: {
  readonly sessions: readonly SessionView[];
  readonly onOpenSession?: (sessionId: string) => void;
}) {
  const [showFinished, setShowFinished] = useState(false);
  const active = activeSubFerrets(sessions);
  const finished = sessions.filter(view => !active.includes(view));
  return (
    <div className="fy-sub-ferret-pack" data-sub-ferret-pack="">
      {active.length === 0 ? <span className="fy-info-muted">None active</span> : null}
      {active.length === 0 ? null : <SubFerretList items={subFerretItems(active, onOpenSession)} />}
      {finished.length === 0 ? null : (
        <>
          <button
            aria-expanded={showFinished}
            className="fy-sub-ferret-finished-toggle"
            data-sub-ferret-finished-toggle=""
            onClick={() => setShowFinished(current => !current)}
            type="button"
          >
            {showFinished ? 'Hide' : 'Show'} finished ({finished.length})
          </button>
          {showFinished ? <SubFerretList items={subFerretItems(finished, onOpenSession)} /> : null}
        </>
      )}
    </div>
  );
}
