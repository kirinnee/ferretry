/**
 * Onboarding's wire schemas. The first-run flow is NEW as a plugin in 5.0 (today it is `fleet setup scan` and the
 * app's onboarding feature); the shapes follow design §4.12 and §6.1: every step is find / ask / later, and everything
 * is "find before asking, ask only what the next step needs, leave the rest for first use".
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

/** A step is `<plugin>:<id>`; the plugin is the one whose manifest declared it. */
export const StepPluginSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const StepIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

/**
 * Where one step stands for this owner.
 * `pending` not looked at; `found` the find step saw it is already done; `asked` the smallest question is on screen;
 * `later` left for its first use; `done` answered; `skipped` the owner declined.
 */
export const StepStateSchema = z.enum(['pending', 'found', 'asked', 'later', 'done', 'skipped']);
export type StepState = z.infer<typeof StepStateSchema>;

/** What a step's `find` saw, as one sentence the person reads. Never a credential or a path into a sign-in store. */
export const StepFoundSchema = z.strictObject({
  found: z.boolean(),
  summary: z.string().min(1).max(300),
});
export type StepFound = z.infer<typeof StepFoundSchema>;

/** The smallest question a step asks when `find` found nothing. */
export const StepAskSchema = z.strictObject({
  prompt: z.string().min(1).max(300),
  /** The one command that answers it at a terminal, when there is one. */
  command: z.string().min(1).max(300).optional(),
});
export type StepAsk = z.infer<typeof StepAskSchema>;

export const StepViewSchema = z.strictObject({
  plugin: StepPluginSchema,
  id: StepIdSchema,
  title: z.string().min(1),
  order: z.number().int(),
  state: StepStateSchema,
  found: StepFoundSchema.optional(),
  ask: StepAskSchema.optional(),
  /** The moment it will ask instead ("when a ferret first needs a secret"). */
  later: z.string().min(1).max(200).optional(),
  at: InstantSchema.optional(),
});
export type StepView = z.infer<typeof StepViewSchema>;

/** `GET /v1/onboarding`. */
export const OnboardingViewSchema = z.strictObject({
  steps: z.array(StepViewSchema),
  /** Every step is found, done, later or skipped. */
  complete: z.boolean(),
});
export type OnboardingView = z.infer<typeof OnboardingViewSchema>;

/** `POST /v1/onboarding/steps/:plugin/:stepId`: record how the owner answered. Grants nothing by itself. */
export const StepAnswerRequestSchema = z.strictObject({ state: z.enum(['done', 'later', 'skipped']) });
export type StepAnswerRequest = z.infer<typeof StepAnswerRequestSchema>;

/** `state/onboarding/progress.json`. */
export const ProgressSchema = z.strictObject({
  format: z.literal(1),
  steps: z.record(z.string(), z.strictObject({ state: StepStateSchema, at: InstantSchema })),
});
export type Progress = z.infer<typeof ProgressSchema>;

export const ONBOARDING_CODES = {
  unknownStep: 'onboarding_unknown_step',
  findFailed: 'onboarding_find_failed',
} as const;
