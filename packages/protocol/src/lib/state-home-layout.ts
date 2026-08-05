/**
 * The one rule that decides whether a directory may be used as a Ferretry state home.
 *
 * SINGLE-SOURCED HERE because two production writers have to agree on it — the daemon, which
 * bootstraps the home it serves from, and the command-line client, which creates state inside that
 * home before the daemon has ever run — and they live in packages that may not import each other.
 * The protocol package is the one thing both already depend on.
 *
 * The hazard is not hypothetical; it has shipped twice. Creating state in a home and CLAIMING that
 * home were separate operations, so the client manufactured exactly the arrangement the daemon
 * refuses: a non-empty directory carrying no marker. The daemon then declined to boot forever, and
 * the only move left to an owner was to delete the installation they had just provisioned. The first
 * instance was the log directory; the second was a provisioned fleet. Both had the same shape — one
 * artefact, two writers, no agreement — and both passed their own tests, because each side owned its
 * own fixture.
 *
 * So the DECISION lives here, not merely the version number. A client that wrote the marker under
 * its own rule would be free to adopt a directory that is genuinely somebody else's, which is the
 * guard this exists to keep rather than to weaken. One rule, two callers: a home is claimed at the
 * moment it is created, by whichever side creates it, and neither side may adopt a directory
 * Ferretry did not create.
 *
 * `scripts/validate/cli-contracts.sh state-home-layout-claim` pins the literals so neither package
 * can grow a second copy, exactly as the two-name model and the default daemon address are pinned.
 */

/** The layout this release creates and the only one it can serve. */
export const CURRENT_LAYOUT_VERSION = 1 as const;

/**
 * The marker's file name, relative to the state home.
 *
 * Both packages derive their own absolute path from this rather than spelling the name twice: a
 * daemon looking for one name while a client writes another is a daemon that refuses the very home
 * its client just claimed, and neither side would say anything useful about why.
 */
export const LAYOUT_VERSION_FILENAME = 'layout-version';

/**
 * The marker's mode: readable and writable by its owner alone.
 *
 * A state home holds an owner-only credential and a daemon identity key, and the home itself is
 * `0o700`. The marker carries nothing secret, but a file group- or world-writable inside an
 * otherwise-private tree is an inconsistency a reviewer has to stop and reason about, so it does not
 * exist.
 */
export const LAYOUT_VERSION_MODE = 0o600;

/** The exact bytes a claim writes, so a hand comparison and a program compare the same thing. */
export function layoutVersionContent(version: number = CURRENT_LAYOUT_VERSION): string {
  return `${String(version)}\n`;
}

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

/**
 * Whether this directory may be claimed, used, or must be left alone.
 *
 * `recoverableBootstrap` is how a caller says "I looked, and everything in here is a shape only we
 * produce". It is deliberately an input rather than something decided here: recognising our own
 * partial scaffold means walking a filesystem, and this function stays pure so both packages can
 * call it and a test can drive every arm from values.
 */
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
