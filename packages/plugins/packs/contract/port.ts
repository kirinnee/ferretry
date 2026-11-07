import { definePort } from '@ferretry/kernel/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { FerretPackPatchResult, FerretResult, PackRecommendation, PackView } from './wire.ts';
import type { PackTable } from './table.ts';

/**
 * What the app, `fy` and other plugins read from Packs (§2.3: recommend, pack limits, routing). Starting a helper is
 * Ferrets' (`fy new`); Packs shapes a start only through its `start.decide` taker and the start options.
 */
export interface PacksApi {
  /** The settings, the routing prompt in effect, the vocabulary and the models usable now. */
  view(): Promise<PackView>;
  /** The routing prompt and the models usable now; nothing is matched against the task. */
  recommend(input: { readonly task?: string | undefined }): Promise<PackRecommendation>;
  /** The routing prompt as the one line a Pack ferret's launch carries (`FY_PACK_ROUTING`). */
  routingLine(): Promise<string>;
  /** Whether a ferret is told about Pack mode at its next launch: the machine's switch, its own, and its depth. */
  instructed(ferret: FerretId): Promise<boolean>;
  /** What a finished ferret reported with `signal done`; `undefined` when there is no such ferret. */
  result(ferret: FerretId): Promise<FerretResult | undefined>;
  /** A lead's one-table view of its pack; `undefined` when there is no such ferret. `caller` is the asking ferret. */
  table(ferret: FerretId, caller?: FerretId): Promise<PackTable | undefined>;
  /** One ferret's own switch; `undefined` when there is no such ferret. */
  setSwitch(ferret: FerretId, enabled: boolean): Promise<FerretPackPatchResult | undefined>;
}

export const PacksPort = definePort<PacksApi>('packs');
