/** The Actions ▾ menu's rows another plugin owns (see {@link ActionsRowSlotProps}). */
export const ACTIONS_ROW_SLOT = 'ferrets.actions-row' as const;

/**
 * The Actions ▾ menu's rows that another plugin owns (Interrupt, Fork into a new ferret…, Add MCP server, Compact memory
 * at…, the Warden and learning actions). The menu mounts this slot beside its own rows and hands each contributing
 * panel the ferret and a way to OFFER rows; a panel draws nothing itself, it offers a row while it applies and takes it
 * back (`null`) when it does not or unmounts. Rows are plain data (no icon, no framework node): the menu draws them
 * as it draws its own. A row that needs a form opens its own surface from `run`.
 */

/** Where in the Actions menu an offered row sits (the menu's own sections). */
export type ActionsRowGroup = 'ferret' | 'move' | 'danger';

interface ActionsRowBase {
  /** Stable within the menu; two rows with one id keep the first. */
  readonly id: string;
  readonly label: string;
  readonly group: ActionsRowGroup;
  /** Within its group, lower first. */
  readonly order: number;
  /** A short fact at the row's end. */
  readonly detail?: string;
  readonly danger?: boolean;
  /** Why it cannot be done now: the row is drawn dimmed and does nothing. */
  readonly unavailable?: string;
}

/** A row that does its work at once, or asks inside the menu first. */
export type ActionsRowOffer =
  | (ActionsRowBase & { readonly kind: 'run'; readonly run: () => Promise<void> | void })
  | (ActionsRowBase & {
      readonly kind: 'confirm';
      readonly question: string;
      readonly consequence: string;
      readonly confirmLabel: string;
      readonly run: () => Promise<void> | void;
    });

export interface ActionsRowSlotProps {
  /** The ferret the menu is for. */
  readonly ferret: string;
  readonly name: string;
  /** Whether this connection may change the ferret (the menu's own flag). */
  readonly canControl: boolean;
  /** Offers (or, with `null`, withdraws) the row `id`. */
  readonly offer: (id: string, row: ActionsRowOffer | null) => void;
}

export function isActionsRowSlotProps(props: unknown): props is ActionsRowSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return (
    typeof candidate.ferret === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.canControl === 'boolean' &&
    typeof candidate.offer === 'function'
  );
}

export default { slot: ACTIONS_ROW_SLOT } as const;
