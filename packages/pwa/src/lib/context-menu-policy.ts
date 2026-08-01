/**
 * Selection context-menu policy shared by transcript surfaces.
 *
 * A touch long-press is the browser's text-selection gesture. Replacing its
 * native menu hides the selection handles, so only a known mouse right-click
 * may open Ferretry's quote/pin menu.
 */

/** Normalised provenance for a context-menu event. */
export type PointerKind = 'mouse' | 'touch' | 'pen' | 'unknown';

const KNOWN_KINDS = new Set<string>(['mouse', 'touch', 'pen']);

/**
 * Resolve an event's pointer provenance. The context-menu event wins when it
 * carries one; otherwise the remembered pointer press is the safe fallback.
 */
export const resolvePointerKind = (
  eventPointerType: string | null | undefined,
  lastPointerType: string | null | undefined,
): PointerKind => {
  const fromEvent = typeof eventPointerType === 'string' ? eventPointerType : '';
  if (KNOWN_KINDS.has(fromEvent)) return fromEvent as PointerKind;
  const fromPress = typeof lastPointerType === 'string' ? lastPointerType : '';
  if (KNOWN_KINDS.has(fromPress)) return fromPress as PointerKind;
  return 'unknown';
};

export interface TextContextMenuInput {
  readonly pointerKind: PointerKind;
  /** Used only for unknown provenance, where the safe choice is hands-off. */
  readonly touchAffected: boolean;
  /** Whether a non-empty selection inside the owned text surface exists. */
  readonly hasSelection: boolean;
}

/** Whether a text surface may replace the browser's native context menu. */
export const textContextMenuAllowed = ({ pointerKind, touchAffected, hasSelection }: TextContextMenuInput): boolean => {
  if (!hasSelection) return false;
  if (pointerKind === 'touch' || pointerKind === 'pen') return false;
  if (pointerKind === 'unknown') return !touchAffected;
  return true;
};

/** The browser event shape needed for the policy. */
export interface ContextMenuEventLike {
  readonly pointerType?: string | null;
}

/** Resolve event provenance and apply the policy in one handler-ready call. */
export const textContextMenuEventAllowed = (
  event: ContextMenuEventLike | null | undefined,
  context: { readonly lastPointerType: string | null; readonly touchAffected: boolean; readonly hasSelection: boolean },
): boolean =>
  textContextMenuAllowed({
    pointerKind: resolvePointerKind(event?.pointerType, context.lastPointerType),
    touchAffected: context.touchAffected,
    hasSelection: context.hasSelection,
  });
