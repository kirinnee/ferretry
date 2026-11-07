import { z } from 'zod';

/**
 * The plain schemas the agenda wire shapes share (today's `protocol/src/lib/common.ts`, the part Asks reads). An
 * instant here is the unbranded ISO string today's items store, so the copied engine's types stay as they were.
 */

/** An ISO-8601 instant with an explicit timezone. */
export const InstantSchema = z.iso.datetime({ offset: true });

export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const PositiveIntegerSchema = z.number().int().positive();
