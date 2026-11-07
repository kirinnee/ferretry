import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { InstantSchema } from '@ferretry/std';
import { FerretWaitingSchema } from '../../contract/index.ts';

/**
 * The session documents Ferrets keeps under `state/ferrets/<session>/` that no other piece reads (§9.2): declared
 * here and listed in the manifest's `data.state`. The documents the converter also writes — config, state, pins,
 * agent pins, details — are the contract's (`contract/ferret-files.ts`).
 */

/**
 * What a finished ferret handed back with `signal done`: `state/ferrets/<ferret>/summary.md`, beside its `ferret.json`
 * (today's session `summary.md`, written by the signal's `FileSignalArtifacts.writeSummary`). Text as the ferret wrote
 * it, never parsed here: `FerretsApi.summary` hands it to a reader that masks it inside one `Redaction.read`.
 */
export const FerretSummaryFiles = defineState<'summary', Uint8Array>({
  name: 'summary',
  path: '*/summary.md',
  store: 'opaque',
  format: 1,
  mode: 0o600,
});

/**
 * A ferret's declared wait and the time it has been credited for waiting: `state/ferrets/<ferret>/waiting.json` (today's
 * `waiting` and `waitingCreditSeconds` on the session's state document). `ferret.json` is frozen, and a wait moves
 * far more often than who a ferret is. The credit outlives the wait: the turn ceiling must never charge a ferret for
 * time it spent deliberately parked. Private to Ferrets.
 */
export const FerretWaitFiles = defineState({
  name: 'waiting',
  path: '*/waiting.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({
    waiting: FerretWaitingSchema.optional(),
    creditSeconds: z.number().int().nonnegative().optional(),
    /** When the ferret said `signal done` (see `FerretSummary.finishedAt`). */
    finishedAt: InstantSchema.optional(),
  }),
  mode: 0o600,
  onDamaged: { narrower: 'a damaged waiting.json reads as no declared wait and no credit' },
});
