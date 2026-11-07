import { defineEvent, definePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type {
  FerretPackPatchResult,
  FerretResult,
  PackNewOutcome,
  PackNewRequest,
  PackRecommendation,
  PackView,
} from './wire.ts';
import type { PackTable } from './table.ts';

/** Who asked, as the boundary decided it: an agent's start is held out of the state home and cannot name `--cwd`. */
export interface PackCaller {
  readonly agent: boolean;
}

/**
 * What the app, `fy` and other plugins read from Packs (§2.3: recommend, helper start, pack limits, routing).
 * A refusal to start is an ANSWER (`PackNewOutcome.outcome === 'refused'`), never an exception: a ferret reads the
 * closed code and every attempt from one value and falls back to its next candidate.
 */
export interface PacksApi {
  /** The settings, the routing prompt in effect, the vocabulary and the models usable now. */
  view(): Promise<PackView>;
  /** The routing prompt and the models usable now; nothing is matched against the task. */
  recommend(input: { readonly task?: string | undefined }): Promise<PackRecommendation>;
  /** `fy new`: admission, the candidate order, the probe, then the start. */
  newHelper(request: PackNewRequest, caller: PackCaller): Promise<PackNewOutcome>;
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

/** A helper was started through `fy new`. A wake-up for views; the truth is the Ferrets port. */
export const PackHelperStarted = defineEvent(
  'packs.helper-started',
  z.strictObject({ ferret: z.string().min(1), parent: z.string().min(1).optional(), runtime: z.string().min(1) }),
);
