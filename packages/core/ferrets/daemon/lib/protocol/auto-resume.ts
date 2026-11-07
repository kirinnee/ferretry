import { z } from 'zod';
import { InstantSchema, NonEmptyStringSchema, NonNegativeIntegerSchema } from './common.ts';

/**
 * One session the daemon looked at when it came back up after a restart and could NOT resume on its own,
 * with the reason a person can act on ("couldn't auto-resume: <reason>").
 */
export const AutoResumeSkippedSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  reason: NonEmptyStringSchema,
});
export type AutoResumeSkipped = z.infer<typeof AutoResumeSkippedSchema>;

/**
 * What the last "Auto-resume after restart" pass did: how many ferrets were brought back with their
 * conversation intact, and which could not be, each with why. Carried on the machine view, so the app
 * can say "Resumed 5 ferrets after restart" without a route of its own.
 */
export const AutoResumeSummarySchema = z.strictObject({
  at: InstantSchema,
  resumed: NonNegativeIntegerSchema,
  skipped: z.array(AutoResumeSkippedSchema).readonly(),
});
export type AutoResumeSummary = z.infer<typeof AutoResumeSummarySchema>;
