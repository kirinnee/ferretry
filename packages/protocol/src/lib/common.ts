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

const SMALL_NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * A short span in words, built from the constant that owns it so the sentence cannot drift from the length: "two
 * minutes", "one minute", "90 seconds". Whole minutes are said in minutes, ten or fewer spelled out.
 */
export const durationWords = (seconds: number): string => {
  const minutes = seconds >= 60 && seconds % 60 === 0;
  const count = minutes ? seconds / 60 : seconds;
  return `${SMALL_NUMBER_WORDS[count] ?? String(count)} ${minutes ? 'minute' : 'second'}${count === 1 ? '' : 's'}`;
};

/** How many times, in words: "once", "twice", "3 times". */
export const timesWords = (count: number): string =>
  count === 1 ? 'once' : count === 2 ? 'twice' : `${String(count)} times`;
