/**
 * THE ROWS ANOTHER PLUGIN OFFERS the Actions ▾ menu through the `ferrets.actions-row` slot (contract/slots.ts).
 *
 * A contributing panel draws nothing: it calls `offer(id, row)` while its action applies and `offer(id, null)` when it
 * does not or unmounts. The rows are plain data, so this turns each into the menu's own contribution shape (an icon of
 * the menu's choosing) and the menu draws it like one of its own rows. Pure apart from the one state the hook holds.
 */

import type { ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import {
  CircleX,
  Hand,
  type LucideIcon,
  ListOrdered,
  Plug,
  Puzzle,
  ShieldQuestion,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { CoreActionContext } from './core-actions.ts';
import type { FerretActionContribution, FerretActionEntry } from './registry.ts';

/**
 * The icon each offered row is drawn with, by the row's own id: the menu chooses it (a row is plain data and carries no
 * icon). A row this table does not know keeps the generic puzzle piece, so a plugin's new row is drawn before it is listed.
 */
const OFFERED_ROW_ICONS: Readonly<Record<string, LucideIcon>> = {
  'interrupt-turn': Hand,
  'add-mcp': Plug,
  'add-skills': Sparkles,
  'warden-investigate': ShieldQuestion,
  'clear-stuck-messages': Trash2,
  'dismiss-cancelled-messages': CircleX,
  'open-queue': ListOrdered,
};

/** The icon an offered row is drawn with. */
export const offeredRowIcon = (id: string): LucideIcon => OFFERED_ROW_ICONS[id] ?? Puzzle;

const entryOf = (row: ActionsRowOffer): FerretActionEntry => {
  const base = {
    id: row.id,
    label: row.label,
    icon: offeredRowIcon(row.id),
    ...(row.detail === undefined ? {} : { detail: row.detail }),
    ...(row.danger === true ? { danger: true } : {}),
    ...(row.unavailable === undefined ? {} : { unavailable: row.unavailable }),
  };
  return row.kind === 'run'
    ? { ...base, kind: 'run', run: row.run }
    : {
        ...base,
        kind: 'confirm',
        question: row.question,
        consequence: row.consequence,
        confirmLabel: row.confirmLabel,
        run: row.run,
      };
};

/** One offered row as a menu contribution. */
export const contributionOf = (row: ActionsRowOffer): FerretActionContribution<CoreActionContext> => ({
  group: row.group,
  order: row.order,
  build: () => entryOf(row),
});

/** The rows offered so far, as contributions in the order they were first offered, and the `offer` the slot is handed. */
export function useOfferedRows(): {
  readonly offer: (id: string, row: ActionsRowOffer | null) => void;
  readonly contributions: readonly FerretActionContribution<CoreActionContext>[];
} {
  const [offered, setOffered] = useState<ReadonlyMap<string, ActionsRowOffer>>(new Map());
  const offer = useCallback((id: string, row: ActionsRowOffer | null): void => {
    setOffered(previous => {
      const next = new Map(previous);
      if (row === null) next.delete(id);
      else next.set(id, row);
      return next;
    });
  }, []);
  const contributions = useMemo(() => [...offered.values()].map(contributionOf), [offered]);
  return { offer, contributions };
}
