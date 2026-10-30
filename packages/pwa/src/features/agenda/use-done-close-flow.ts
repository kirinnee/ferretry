/**
 * THE STATE OF ONE "DONE · CLOSES" TAP: idle, asking which cards (when more than one is linked), or closing.
 *
 * The cards are closed FIRST and the item is resolved only when they all are; a card that will not close
 * leaves the item open with the reason. While the close is in flight the button is disabled, so a second tap
 * cannot close twice.
 */

import type { TaskRef } from '@ferretry/protocol';
import { useEffect, useRef, useState } from 'react';
import { type DoneCloseCard, type DoneCloseSource, doneCloseLabel } from '../../lib/agenda-done-close.ts';

interface DoneCloseConfirmView {
  readonly cards: readonly DoneCloseCard[];
  readonly ticked: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export interface DoneCloseView {
  readonly label: string;
  /** The close is in flight. */
  readonly busy: boolean;
  /** Why the last close did not go through; the item is still open. */
  readonly error: string | null;
  /** The checklist, while the owner is choosing among several cards. */
  readonly confirm: DoneCloseConfirmView | null;
  readonly onTap: () => void;
}

export const useDoneCloseFlow = (
  source: DoneCloseSource | undefined,
  /** Resolves the agenda item, once every card is closed. */
  resolve: (label: string) => void,
): DoneCloseView | undefined => {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'closing'>('idle');
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  if (source === undefined) return undefined;
  const { cards } = source;
  const label = doneCloseLabel(cards.map(card => card.ref));

  const run = async (refs: readonly TaskRef[]): Promise<void> => {
    setPhase('closing');
    setError(null);
    const result = await source.close(refs);
    if (!alive.current) return;
    setPhase('idle');
    if (result.ok) resolve(label);
    else setError(result.message);
  };

  const onTap = (): void => {
    if (phase === 'closing') return;
    if (cards.length > 1) {
      setTicked(new Set(cards.map(card => card.ref.id)));
      setError(null);
      setPhase('confirm');
      return;
    }
    void run(cards.map(card => card.ref));
  };

  return {
    label,
    busy: phase === 'closing',
    error,
    onTap,
    confirm:
      phase === 'idle'
        ? null
        : {
            cards,
            ticked,
            onToggle: id =>
              setTicked(current => {
                const next = new Set(current);
                if (!next.delete(id)) next.add(id);
                return next;
              }),
            onConfirm: () => void run(cards.filter(card => ticked.has(card.ref.id)).map(card => card.ref)),
            onCancel: () => setPhase('idle'),
          },
  };
};
