import type { FoundationPaths } from './paths.ts';

export const CURRENT_LAYOUT_VERSION = 1 as const;
/**
 * Version 2 creates `events.jsonl`, empty, as part of creating the session directory, before the
 * marker is written. The marker is therefore durable, non-disposable proof that a journal exists,
 * which the SQLite index — dropped and rebuilt by design — can never be.
 */
export const CURRENT_SESSION_VERSION = 2 as const;

export type LayoutRefusalReason = 'missing-marker' | 'invalid-version' | 'unsupported-version';

export type LayoutDecision =
  | { readonly kind: 'initialize'; readonly version: typeof CURRENT_LAYOUT_VERSION }
  | { readonly kind: 'proceed'; readonly version: typeof CURRENT_LAYOUT_VERSION }
  | {
      readonly kind: 'refuse';
      readonly reason: LayoutRefusalReason;
      readonly found: string | undefined;
      readonly expected: typeof CURRENT_LAYOUT_VERSION;
    };

export function decideLayout(
  marker: string | undefined,
  rootEntries: readonly string[],
  recoverableBootstrap = false,
): LayoutDecision {
  if (marker === undefined) {
    return rootEntries.length === 0 || recoverableBootstrap
      ? { kind: 'initialize', version: CURRENT_LAYOUT_VERSION }
      : { kind: 'refuse', reason: 'missing-marker', found: undefined, expected: CURRENT_LAYOUT_VERSION };
  }
  const value = marker.trim();
  if (!/^[1-9]\d*$/.test(value)) {
    return { kind: 'refuse', reason: 'invalid-version', found: value, expected: CURRENT_LAYOUT_VERSION };
  }
  const version = Number(value);
  return version === CURRENT_LAYOUT_VERSION
    ? { kind: 'proceed', version: CURRENT_LAYOUT_VERSION }
    : { kind: 'refuse', reason: 'unsupported-version', found: value, expected: CURRENT_LAYOUT_VERSION };
}

export type SessionMarkerDecision = 'proceed' | 'refuse';

const LEGACY_SESSION_VERSION = '1' as const;
const SUPPORTED_SESSION_VERSIONS: ReadonlySet<string> = new Set([
  LEGACY_SESSION_VERSION,
  String(CURRENT_SESSION_VERSION),
]);

/**
 * Whether a session directory may be read at all.
 *
 * Deliberately still two-valued: every call site compares against `'proceed'` or `'refuse'`, and a
 * third arm for "legacy" would silently read every version-1 session as refused and drop it from the
 * index. The version-specific questions are separate predicates below.
 */
export function decideSessionMarker(marker: string | undefined): SessionMarkerDecision {
  return marker !== undefined && SUPPORTED_SESSION_VERSIONS.has(marker.trim()) ? 'proceed' : 'refuse';
}

/** Under version 2 a missing journal is lost history, never emptiness. */
export function sessionJournalRequired(marker: string | undefined): boolean {
  return marker?.trim() === String(CURRENT_SESSION_VERSION);
}

/** A version-1 directory predates the journal contract and is upgraded in place. */
export function sessionMarkerNeedsUpgrade(marker: string | undefined): boolean {
  return marker?.trim() === LEGACY_SESSION_VERSION;
}

export class StateHomeLayoutError extends Error {
  constructor(
    readonly paths: FoundationPaths,
    readonly decision: Extract<LayoutDecision, { kind: 'refuse' }>,
  ) {
    super(
      decision.reason === 'missing-marker'
        ? `state home ${paths.home} is non-empty but has no layout-version marker`
        : `state home ${paths.home} has layout version ${JSON.stringify(decision.found)}; expected ${decision.expected}`,
    );
    this.name = 'StateHomeLayoutError';
  }
}
