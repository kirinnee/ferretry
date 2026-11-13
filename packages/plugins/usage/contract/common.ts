import { z } from 'zod';

export {
  NonEmptyStringSchema,
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from '@ferretry/std';

/**
 * The plain ISO instant today's analytics and performance wire carries. Unlike `@ferretry/std`'s `InstantSchema` it does
 * not rewrite the offset to UTC: an index row stores the instant it was ingested with, and a rate is applied from one.
 */
export const InstantSchema = z.iso.datetime({ offset: true });
