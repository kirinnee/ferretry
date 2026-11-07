import { z } from 'zod';

/** An ISO-8601 instant with an explicit timezone (the contract owns it: `IsoInstantSchema`). */
export { IsoInstantSchema as InstantSchema } from '../records.ts';

export const NonEmptyStringSchema = z.string().trim().min(1);
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const PositiveIntegerSchema = z.number().int().positive();
export const NonNegativeFiniteSchema = z.number().finite().nonnegative();
