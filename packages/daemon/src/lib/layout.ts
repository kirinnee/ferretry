import type { FoundationPaths } from './paths.ts';

export const CURRENT_LAYOUT_VERSION = 1 as const;
export const CURRENT_SESSION_VERSION = 1 as const;

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

export function decideSessionMarker(marker: string | undefined): SessionMarkerDecision {
  return marker?.trim() === String(CURRENT_SESSION_VERSION) ? 'proceed' : 'refuse';
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
