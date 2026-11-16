import { defineEvent, definePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretStateSchema } from './ids.ts';
import type { FerretsApi } from './generated/ferrets-api.ts';

// Every slice's TYPES keep their old home: `./port.ts` still exports them (the generated file re-exports `ports/*.port.ts`).
export type * from './generated/ferrets-api.ts';
// The four runtime values of the start request live in the lifecycle slice; a type-only re-export cannot carry them,
// and the manifest loader runs before the generated file exists.
export {
  HarnessFlagSchema,
  InitialAttachmentSchema,
  MAX_HARNESS_FLAG_LENGTH,
  MAX_HARNESS_FLAGS,
  StartOptionsSchema,
} from './ports/lifecycle.port.ts';

/**
 * The Ferrets port (§2.2): who each ferret is, its lineage, its state; start, stop and resume through the harness
 * and runner plugins. "A ferret touches only its own; a lead also its helpers'" is `mayTouch`, decided here and
 * nowhere else.
 */
export const FerretsPort = definePort<FerretsApi>('ferrets');

/**
 * A ferret was added, changed state, or went away. A wake-up for views; the truth is `FerretsPort`.
 * State and absence also let Vault end its input values without a needs cycle back to Ferrets (I108).
 * Missing state says nothing about whether the ferret ended: readers keep masking until they know.
 */
export const FerretsChanged = defineEvent(
  'ferrets.changed',
  z.strictObject({
    ferret: z.string().min(1),
    generation: z.number().int(),
    state: FerretStateSchema.optional(),
    gone: z.literal(true).optional(),
  }),
);
