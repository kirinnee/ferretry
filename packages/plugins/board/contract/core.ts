/**
 * STAND-IN for the core contracts (`@ferretry/core-ferrets/contract`, `@ferretry/core-asks/contract`) until the
 * core-contracts slice lands on origin/rebuild/5.0. It is the ONLY file in this package that names a core
 * hook/event/id/port; when the real contracts merge, replace the body of this file with re-exports of the same names.
 */
import { defineEvent, defineHook, definePort, type FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';

export type { FerretId };
export const FerretIdSchema = z
  .string()
  .min(1)
  .transform(value => value as FerretId);

/** Stand-in for the slice of `FerretsPort` Board reads (who a ferret is, its parent). */
export interface FerretsApi {
  exists(ferret: FerretId): Promise<boolean>;
  parentOf(ferret: FerretId): Promise<FerretId | undefined>;
}
export const FerretsPort = definePort<FerretsApi>('ferrets');

/** Stand-in for the slice of `AsksPort` Board uses: raise an ask for an obligation (idempotent). The card never asks. */
export interface AsksApi {
  raise(ask: {
    readonly source: string;
    readonly ref: string;
    readonly entry?: string;
  }): Promise<{ readonly ask: string }>;
}
export const AsksPort = definePort<AsksApi>('asks');

export const AskSources = defineHook('ask.sources', { mode: 'provide', key: z.string(), value: z.custom<unknown>() });
export const AskAnswered = defineEvent(
  'asks.answered',
  z.strictObject({ ask: z.string(), source: z.string(), ref: z.string(), entry: z.string().optional() }),
);
export const StartDecide = defineHook('start.decide', {
  mode: 'decide',
  input: z.strictObject({
    ferret: FerretIdSchema,
    parent: FerretIdSchema.optional(),
    login: z.string().optional(),
    model: z.string().optional(),
    runtime: z.string().optional(),
  }),
});
export const SitrepLines = defineHook('sitrep.lines', {
  mode: 'contribute',
  item: z.strictObject({ ferret: FerretIdSchema, text: z.string() }),
});
