/**
 * THE SLOTS FERRETS OFFERS (§5.2: plugin screens offer their own, named `<plugin>.<name>`).
 *
 * Two places in Ferrets' own pages need to ask "which runtime?" and Ferrets must not know how that is drawn or read:
 * the page that starts a new ferret, and the page that moves a ferret to another runtime. Each page OFFERS a slot and
 * mounts whatever panels any installed plugin contributes to it; Runtimes contributes the runtime picker (with its
 * health and quota). Neither half imports the other — the slot name and the props below are the whole agreement, so a
 * daemon without Runtimes shows the page without a picker and a Runtimes without these pages shows nothing extra.
 *
 * The props are plain data and callbacks (no framework type: this is a contract). A page hands them to the slot with
 * the shell's `PanelSlot`; a contributing panel reads them from its props and answers only through the callbacks.
 */
import type { HarnessKey } from './ids.ts';

/** The new-ferret page's runtime field. */
export const NEW_FERRET_ACCOUNT_SLOT = 'ferrets.new-ferret-account' as const;
/** The move page's runtime field. */
export const MOVE_ACCOUNT_SLOT = 'ferrets.move-account' as const;

/** Every slot Ferrets' pages offer, in one list a test can pair against the panels the other plugins contribute. */
export const FERRET_SLOTS = [NEW_FERRET_ACCOUNT_SLOT, MOVE_ACCOUNT_SLOT] as const;
export type FerretSlot = (typeof FERRET_SLOTS)[number];

/** A runtime the owner picked, as far as the page needs to know it (the model box follows it). */
export interface ChosenFerretAccount {
  /** What a ferret is started or moved with: the runtime's wrapper id. */
  readonly wrapper: string;
  readonly displayName: string;
  readonly kind: HarnessKey;
  /** `null` = the harness's own default. */
  readonly defaultModel: string | null;
  readonly models: readonly {
    readonly id: string;
    readonly label?: string;
    readonly available: boolean;
  }[];
  /** The login's model catalog, when it reads one; `customIds` means the model box also takes a typed id. */
  readonly modelCatalog?: { readonly id: string; readonly label: string; readonly customIds: boolean };
}

/** What every account slot's page hands its panels, besides the shell's `subject`. */
interface AccountSlotProps {
  /** The typed draft: the wrapper the ferret would start (or move) on. The page owns it; a panel only proposes. */
  readonly value: string;
  readonly onValueChange: (next: string) => void;
  /** Told which offered runtime the draft names now (or `null`), so the model box can follow it. */
  readonly onChosen: (chosen: ChosenFerretAccount | null) => void;
  /** The id the typed fallback input takes, so the page's own label keeps pointing at it. */
  readonly fallbackId: string;
  /** The element naming this field, for the radio group. */
  readonly labelId: string;
  readonly fallbackPlaceholder: string;
  /**
   * What the page draws INSTEAD of the picker when the roster was read and nothing can run a ferret: a rendered node of
   * the page's own framework, opaque here.
   */
  readonly noAccounts: unknown;
}

export interface NewFerretAccountSlotProps extends AccountSlotProps {
  /** A Launch button's runtime, used only when offered and usable. */
  readonly preferred?: string;
}

export interface MoveAccountSlotProps extends AccountSlotProps {
  /** The ferret is moved within its harness: only this harness's runtimes are offered. */
  readonly harness: HarnessKey;
}

/** Narrowings for a contributing panel: the props are untyped at the shell, so each panel checks what it reads. */
function hasAccountSlotProps(props: unknown): props is AccountSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return (
    typeof candidate.value === 'string' &&
    typeof candidate.onValueChange === 'function' &&
    typeof candidate.onChosen === 'function' &&
    typeof candidate.fallbackId === 'string' &&
    typeof candidate.labelId === 'string' &&
    typeof candidate.fallbackPlaceholder === 'string'
  );
}

export function isNewFerretAccountSlotProps(props: unknown): props is NewFerretAccountSlotProps {
  return hasAccountSlotProps(props);
}

export function isMoveAccountSlotProps(props: unknown): props is MoveAccountSlotProps {
  return hasAccountSlotProps(props) && typeof (props as { harness?: unknown }).harness === 'string';
}
