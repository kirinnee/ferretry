/**
 * A PARENT'S VIEW OF ITS PACK — the sub-ferrets a ferret started, seen from the parent (docs/pack-mode.md).
 *
 * The child already says "Started by <parent>". This is the other direction: Info's "About this ferret" block lists
 * the ACTIVE pack, and a finished or stopped sub-ferret sits behind "Show finished (n)" so a long-running parent's
 * history cannot flood it. Each row is the sub-ferret's name as a link, how it is doing now, and the model it runs on.
 */

import { useState } from 'react';
import type { FerretSummary } from '../../../contract/index.ts';
import { displayCallsign } from '../../lib/callsign.ts';

type SubFerretState = 'starting' | 'working' | 'waiting' | 'idle' | 'done' | 'stopped';

export interface SubFerretReading {
  readonly state: SubFerretState;
  readonly word: string;
  /** Why, when the record said: what it is waiting on. */
  readonly reason?: string;
}

const WORD: Readonly<Record<SubFerretState, string>> = {
  starting: 'Starting',
  working: 'Working',
  waiting: 'Waiting',
  idle: 'At its prompt',
  done: 'Done',
  stopped: 'Stopped',
};

const reading = (state: SubFerretState, reason?: string): SubFerretReading => ({
  state,
  word: WORD[state],
  ...(reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() }),
});

/** How one sub-ferret is doing now, from its record: a stopped ferret that said `signal done` is done. */
export const subFerretState = (ferret: FerretSummary): SubFerretReading => {
  if (ferret.state === 'stopped') return ferret.finishedAt === undefined ? reading('stopped') : reading('done');
  if (ferret.state === 'starting') return reading('starting');
  if (ferret.waiting !== undefined) return reading('waiting', ferret.waiting.condition ?? ferret.waiting.peerName);
  return ferret.state === 'idle' ? reading('idle') : reading('working');
};

/** A sub-ferret is still at work: starting, working, at its prompt, or waiting. */
export const subFerretLive = (read: SubFerretReading): boolean => read.state !== 'done' && read.state !== 'stopped';

/** The name a sub-ferret is called by: its callsign, else its task, else its short id. */
export const subFerretName = (ferret: FerretSummary): string =>
  displayCallsign(ferret.name) || ferret.title || shortFerretId(ferret.id);

const shortFerretId = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

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
  children: readonly FerretSummary[],
  open?: (ferretId: string) => void,
): readonly SubFerretItem[] =>
  children.map(ferret => ({
    id: ferret.id,
    name: subFerretName(ferret),
    reading: subFerretState(ferret),
    ...(ferret.model === undefined ? {} : { model: ferret.model }),
    ...(open === undefined ? {} : { onOpen: () => open(ferret.id) }),
  }));

/** The sub-ferrets still at work. */
export const activeSubFerrets = (children: readonly FerretSummary[]): readonly FerretSummary[] =>
  children.filter(ferret => subFerretLive(subFerretState(ferret)));

/** A small dot and a word for how a sub-ferret is doing, and why when there is a reason. */
export function SubFerretStateLabel({ reading: read }: { readonly reading: SubFerretReading }) {
  return (
    <span className="fy-sub-ferret-state" data-sub-ferret-state={read.state}>
      <span aria-hidden="true" className="fy-sub-ferret-dot" />
      <span>{read.word}</span>
      {read.reason === undefined ? null : <span className="fy-sub-ferret-reason"> — {read.reason}</span>}
    </span>
  );
}

function SubFerretRow({ item }: { readonly item: SubFerretItem }) {
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

export function SubFerretList({ items }: { readonly items: readonly SubFerretItem[] }) {
  return (
    <ul className="fy-sub-ferret-list" data-sub-ferret-list="">
      {items.map(item => (
        <SubFerretRow item={item} key={item.id} />
      ))}
    </ul>
  );
}

/** Info's sub-ferrets: the active ones as a list, the finished ones behind a "Show finished (n)" toggle. */
export function SubFerretsPack({
  ferrets,
  onOpenFerret,
}: {
  readonly ferrets: readonly FerretSummary[];
  readonly onOpenFerret?: (ferretId: string) => void;
}) {
  const [showFinished, setShowFinished] = useState(false);
  const active = activeSubFerrets(ferrets);
  const finished = ferrets.filter(ferret => !active.includes(ferret));
  return (
    <div className="fy-sub-ferret-pack" data-sub-ferret-pack="">
      {active.length === 0 ? <span className="fy-info-muted">None active</span> : null}
      {active.length === 0 ? null : <SubFerretList items={subFerretItems(active, onOpenFerret)} />}
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
          {showFinished ? <SubFerretList items={subFerretItems(finished, onOpenFerret)} /> : null}
        </>
      )}
    </div>
  );
}
