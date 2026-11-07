import { z } from 'zod';

/**
 * The few shared wire primitives the fork, handover, move and transfer schemas use, copied from today's
 * `protocol/src/lib/common.ts` and `client.ts` byte for byte (that file's owner is the app shell; these stay identical so
 * a stored receipt or plan parses the same). Not `@ferretry/std`'s `InstantSchema`: that one normalises the instant,
 * and a durable receipt must read back exactly as written.
 */
export const InstantSchema = z.iso.datetime({ offset: true });
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const PositiveIntegerSchema = z.number().int().positive();

/** Error envelope returned by every JSON API failure. */
export const ApiErrorResponseSchema = z.looseObject({
  error: z.string(),
  code: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

/** The logical request id a retried fork, handover or move carries (today's `FY_REQUEST_ID_HEADER`). */
export const FY_REQUEST_ID_HEADER = 'x-fy-request-id';
