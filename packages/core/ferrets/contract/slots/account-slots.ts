import type { HarnessKey } from '../ids.ts';

/** The new-ferret page's runtime field. */
export const NEW_FERRET_ACCOUNT_SLOT = 'ferrets.new-ferret-account' as const;
/** The move page's runtime field. */
export const MOVE_ACCOUNT_SLOT = 'ferrets.move-account' as const;

/** The two account slots Runtimes contributes its runtime picker to, in one list a test can pair against its panels. */
export const FERRET_ACCOUNT_SLOTS = [NEW_FERRET_ACCOUNT_SLOT, MOVE_ACCOUNT_SLOT] as const;

/** A runtime the owner picked, as far as the page needs to know it (the model box follows it). */
export interface ChosenFerretAccount {
  /** What a ferret is started or moved with: the runtime's wrapper id. */
  readonly wrapper: string;
  readonly displayName: string;
  readonly kind: HarnessKey;
  /** `null` = the harness's own default. */
  readonly defaultModel: string | null;
  /** Discovery supplied no exact default, so a new start needs the person's explicit model choice. */
  readonly requiresModel?: true;
  readonly models: readonly {
    readonly id: string;
    readonly label?: string;
    readonly available: boolean;
    /**
     * Whether the model has a fast mode. `false`: it has none, and the page turns the Fast switch off for it and never
     * sends `fast`. Absent: the panel could not say, and the page lets the daemon accept or refuse it.
     */
    readonly fast?: boolean;
  }[];
  /** The login's model catalog, when it reads one; `customIds` means the model box also takes a typed id. */
  readonly modelCatalog?: { readonly id: string; readonly label: string; readonly customIds: boolean };
  /**
   * The login's live model list (docs/model-catalog.md § Live model list), once the panel has read it: the ids its provider
   * listed and, where this browser may press it, "Refresh list". Absent when the login has no list to give. Information only:
   * it never changes `defaultModel`.
   */
  readonly live?: {
    readonly list:
      | { readonly fetchedAt: string; readonly complete: boolean; readonly ids: readonly string[] }
      | undefined;
    readonly refresh?: { readonly run: () => void; readonly busy: boolean };
  };
}

/** What every account slot's page hands its panels, besides the shell's `subject`. */
interface AccountSlotProps {
  /** The typed draft: the wrapper the ferret would start (or move) on. The page owns it; a panel only proposes. */
  readonly value: string;
  readonly onValueChange: (next: string) => void;
  /** Told which offered runtime the draft names now (or `null`), so the model box can follow it. */
  readonly onChosen: (chosen: ChosenFerretAccount | null) => void;
  /**
   * Told the wrappers this field offers AND can run now, again whenever they change: `null` while the roster is still
   * unread, `[]` when nothing can run. A page that must know whether there is only ONE choice (Conversation's Continue)
   * asks; a panel that cannot say simply never calls it. Optional: a page that does not care leaves it out.
   */
  readonly onOffered?: (wrappers: readonly string[] | null) => void;
  /**
   * Told once, when the roster's first read has finished, answered or failed. The page draws nothing of the form before
   * every field has said so, so the first thing drawn is the real one. Optional: a page that does not wait leaves it out.
   */
  readonly onSettled?: () => void;
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
  /** A picked past conversation was held by this harness: only its runtimes are offered. */
  readonly harness?: HarnessKey;
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
    (candidate.onOffered === undefined || typeof candidate.onOffered === 'function') &&
    (candidate.onSettled === undefined || typeof candidate.onSettled === 'function') &&
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
