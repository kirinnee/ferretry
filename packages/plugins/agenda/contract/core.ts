/**
 * STAND-IN for the core contracts (`@ferretry/core-ferrets/contract`, `@ferretry/core-asks/contract`) until the
 * core-contracts slice lands on origin/rebuild/5.0. It is the ONLY file in this package that names a core
 * hook/event/id/port; when the real contracts merge, replace the body of this file with re-exports of the same names.
 */
import { defineEvent, definePort, type FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';

export type { FerretId };
export const FerretIdSchema = z
  .string()
  .min(1)
  .transform(value => value as FerretId);

/** Stand-in for Asks' one ask. Agenda only shows asks; their full shape is Asks' (`AskSchema`). */
export const AskSchema = z.looseObject({ id: z.string().min(1) });
export type Ask = z.infer<typeof AskSchema>;

/** The slice of `AsksPort` Agenda reads (list what is open, per ferret). */
export interface AsksApi {
  open(ferret: FerretId | 'daemon'): Promise<readonly Ask[]>;
}
export const AsksPort = definePort<AsksApi>('asks');

/** `asks.answered` (Asks): an ask got its answer; Agenda clears its buzz. */
export const AskAnswered = defineEvent(
  'asks.answered',
  z.strictObject({ ask: z.string(), source: z.string(), ref: z.string(), entry: z.string().optional() }),
);
