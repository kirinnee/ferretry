/**
 * What else one save of the Warden's settings may do in the SAME write of `warden.yaml`, and how that save is journaled.
 * It lives beside the sweep service rather than in it so that file stays under its size cap.
 */
import type { WardenConfigPatch } from './config.ts';

/** What else one save of the settings may do in the same write of `warden.yaml`. */
export interface WardenSaveOptions {
  /** Also name the Jev key (`jev.key`): the owner's act, in effect only when the caller is the owner, else held. */
  readonly nameJevKey?: boolean;
}

/** The setting fields one save changed, for the journal: the patch's own, plus `jev` when the save also named the key. */
export function changedFields(patch: WardenConfigPatch, options?: WardenSaveOptions): string[] {
  return options?.nameJevKey === true ? [...Object.keys(patch), 'jev'] : Object.keys(patch);
}
