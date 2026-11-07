import { z } from 'zod';

/** The instant and number shapes a ferret view carries: the contract owns them (`contract/view/common.ts`). */
export {
  InstantSchema,
  NonEmptyStringSchema,
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from '../../../contract/view/common.ts';

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
