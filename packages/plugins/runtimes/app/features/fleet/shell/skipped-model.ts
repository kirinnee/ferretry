/**
 * What the provisioner refused to touch, as the Runtimes tab says it.
 *
 * An apply can leave an operation as the disk has it (a link below a runtime's folder could be swapped to
 * point into the state home between the check and the step, so nothing there is moved, replaced or removed).
 * The daemon keeps the last apply's skips per runtime and serves each runtime's paths INSIDE its folder with
 * the runtime list. This module words them; it never shows the folder's place on disk, and it does not echo
 * the provisioner's own message, which carries that place.
 */

import type { RuntimeView } from '../../../../contract/index.ts';

export interface SkippedItem {
  /** Relative to the runtime's folder. */
  readonly within: string;
  readonly reason: string;
}

/** What the skips share: Ferretry left it as it was, because it is not Ferretry's to change; it names no folder. */
export const SKIPPED_REASON =
  'Ferretry left this as it was: it was added or edited outside Ferretry, or a link here could point outside this runtime.';

export const skippedItems = (runtime: RuntimeView): readonly SkippedItem[] =>
  (runtime.skipped ?? []).map(within => ({ within, reason: SKIPPED_REASON }));

export const skippedCountLine = (count: number): string => `${String(count)} ${count === 1 ? 'item' : 'items'} skipped`;
