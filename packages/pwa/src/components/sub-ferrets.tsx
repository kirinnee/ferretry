/**
 * A PARENT'S VIEW OF ITS PACK — the sub-ferrets a ferret started, seen from the parent (docs/pack-mode.md).
 *
 * The child already says "Started by <parent>". This is the other direction, in two places that read the
 * same rows: the session bar's compact indicator ("3 sub-ferrets · 1 running", which opens the list) and
 * Info's lineage list. Each row is the sub-ferret's name as a link, how it is doing now — with the reason
 * when it failed, stopped or wants you — and the model it runs on (`lib/sub-ferret-state.ts`).
 *
 * The rows are live because the session list they come from is: the page re-reads it, and nothing here
 * keeps a copy.
 */

import type { SessionView } from '@ferretry/protocol';
import { Network } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  type SubFerretReading,
  subFerretModel,
  subFerretName,
  subFerretState,
  subFerretSummary,
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
 * The session bar's indicator: the summary as a button that opens the list beneath it. On a phone only
 * the icon and the count show; the list is the same.
 */
export function SubFerretIndicator({
  sessions,
  compact,
  onOpenSession,
}: {
  /** The sub-ferrets, as `subFerretsOf` lists them. */
  readonly sessions: readonly SessionView[];
  readonly compact: boolean;
  readonly onOpenSession?: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && root.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', close);
    };
  }, [open]);
  if (sessions.length === 0) return null;
  const summary = subFerretSummary(sessions);
  const items = subFerretItems(
    sessions,
    onOpenSession === undefined
      ? undefined
      : (id: string) => {
          setOpen(false);
          onOpenSession(id);
        },
  );
  return (
    <span className="fy-sub-ferret-indicator" data-sub-ferrets="" ref={root}>
      <button
        aria-expanded={open}
        aria-label={compact ? summary : undefined}
        className="fy-sub-ferret-toggle"
        data-sub-ferret-toggle=""
        onClick={() => setOpen(current => !current)}
        title={summary}
        type="button"
      >
        <Network aria-hidden="true" size={13} />
        <span>{compact ? String(sessions.length) : summary}</span>
      </button>
      {open ? (
        <div className="fy-sub-ferret-popover" data-sub-ferret-popover="">
          <p className="fy-sub-ferret-popover-title">{summary}</p>
          <SubFerretList items={items} />
        </div>
      ) : null}
    </span>
  );
}
