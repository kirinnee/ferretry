/**
 * Onboarding's wire schemas. The first-run flow is NEW as a plugin in 5.0 (today it is `fleet setup scan` and the
 * app's onboarding feature); the shapes follow design §4.12 and §6.1: every step is find / ask / later, and everything
 * is "find before asking, ask only what the next step needs, leave the rest for first use".
 *
 * A step is manifest metadata (`manifest.onboarding`: id, title, order) read from the post-build snapshot. Its live check
 * is a route the OWNING plugin declares and the app calls; this plugin records only where each step stands.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

/** A step is `<plugin>:<id>`; the plugin is the one whose manifest declared it. */
export const StepPluginSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const StepIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

/**
 * Where one step stands for this owner. `pending` not looked at; `found` its live check (a route the owning plugin
 * declares, called by the app) saw it is already done; `later` left for its first use; `done` answered; `skipped` the
 * owner declined.
 */
export const StepStateSchema = z.enum(['pending', 'found', 'later', 'done', 'skipped']);
export type StepState = z.infer<typeof StepStateSchema>;

export const StepViewSchema = z.strictObject({
  plugin: StepPluginSchema,
  id: StepIdSchema,
  title: z.string().min(1),
  order: z.number().int(),
  state: StepStateSchema,
  at: InstantSchema.optional(),
});
export type StepView = z.infer<typeof StepViewSchema>;

/** `GET /v1/onboarding`. */
export const OnboardingViewSchema = z.strictObject({
  steps: z.array(StepViewSchema),
  /** Every step is found, done, later or skipped (none pending). */
  complete: z.boolean(),
});
export type OnboardingView = z.infer<typeof OnboardingViewSchema>;

/** `POST /v1/onboarding/steps/:plugin/:stepId`: record how the owner answered. Grants nothing by itself. */
export const StepAnswerRequestSchema = z.strictObject({ state: z.enum(['found', 'done', 'later', 'skipped']) });
export type StepAnswerRequest = z.infer<typeof StepAnswerRequestSchema>;

/** `state/onboarding/progress.json`. */
export const ProgressSchema = z.strictObject({
  format: z.literal(1),
  steps: z.record(z.string(), z.strictObject({ state: StepStateSchema, at: InstantSchema })),
});
export type Progress = z.infer<typeof ProgressSchema>;

export const ONBOARDING_CODES = { unknownStep: 'onboarding_unknown_step' } as const;
