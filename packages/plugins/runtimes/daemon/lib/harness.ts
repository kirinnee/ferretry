/**
 * The one defaulting rule shared by every first-account surface.
 *
 * A caller supplies only positive launch evidence. In particular, an absent or
 * unreadable inventory is not evidence that neither harness can run, so this
 * function deliberately returns no answer for it.
 */
import type { HarnessKind } from './manifest.ts';

export interface FleetHarnessEvidence {
  readonly kind: HarnessKind;
  readonly launchable: readonly string[];
}

/** Prefer Claude when both harnesses are launchable; otherwise use Codex. */
export const defaultFleetHarness = <T extends FleetHarnessEvidence>(
  harnesses: readonly T[],
): HarnessKind | undefined => {
  if (harnesses.some(harness => harness.kind === 'claude' && harness.launchable.length > 0)) return 'claude';
  if (harnesses.some(harness => harness.kind === 'codex' && harness.launchable.length > 0)) return 'codex';
  return undefined;
};
