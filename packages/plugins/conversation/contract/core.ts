/**
 * STAND-IN for the core contracts (`@ferretry/core-ferrets/contract`, `@ferretry/core-asks/contract`) until the
 * core-contracts slice lands on origin/rebuild/5.0. It is the ONLY file in this package that names a core
 * hook/event/id; when the real contracts merge, replace the body of this file with re-exports of the same names.
 */
import { defineHook, type FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';

export type { FerretId };
export const FerretIdSchema = z
  .string()
  .min(1)
  .transform(value => value as FerretId);

export const SitrepLines = defineHook('sitrep.lines', {
  mode: 'contribute',
  item: z.strictObject({ ferret: FerretIdSchema, text: z.string() }),
});
export const AskSources = defineHook('ask.sources', {
  mode: 'provide',
  key: z.string(),
  value: z.custom<unknown>(),
});
