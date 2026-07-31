import { z } from 'zod';

/** An ISO-8601 instant with an explicit timezone. */
export const InstantSchema = z.iso.datetime({ offset: true });

export const NonEmptyStringSchema = z.string().trim().min(1);
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const PositiveIntegerSchema = z.number().int().positive();
export const NonNegativeFiniteSchema = z.number().finite().nonnegative();

export const StringMapSchema = z.record(z.string(), z.unknown());

/** Error envelope returned by every JSON API failure. */
export const ApiErrorResponseSchema = z.looseObject({
  error: z.string(),
  code: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
