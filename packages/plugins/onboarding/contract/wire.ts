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
  /**
   * With `found`: what was found is the terminal's own sign-in, linked rather than made for Ferretry. The step's live
   * check says so when it records the answer, so the fact stays with the check that saw it (the plugin that owns the
   * step), and no screen names a plugin to know it.
   */
  linked: z.literal(true).optional(),
});
export type StepView = z.infer<typeof StepViewSchema>;

/** `GET /v1/onboarding`. */
export const OnboardingViewSchema = z.strictObject({
  steps: z.array(StepViewSchema),
  /** Every step is found, done, later or skipped (none pending). */
  complete: z.boolean(),
  /**
   * This machine already has at least one runtime (Runtimes' own `setUp`, read through its `list`). False when Runtimes
   * is off or cannot be read. It is the machine's fact, not a step answer: a machine set up without `fy onboard` has
   * every step `pending` and is still set up.
   */
  setUp: z.boolean(),
});
export type OnboardingView = z.infer<typeof OnboardingViewSchema>;

/** `POST /v1/onboarding/steps/:plugin/:stepId`: record how the owner answered. Grants nothing by itself. */
export const StepAnswerRequestSchema = z
  .strictObject({
    state: z.enum(['found', 'done', 'later', 'skipped']),
    /** Only a `found` answer can be a linked sign-in (see {@link StepViewSchema}). */
    linked: z.literal(true).optional(),
  })
  .refine(answer => answer.linked === undefined || answer.state === 'found', {
    message: 'only a found step can be a linked sign-in',
  });
export type StepAnswerRequest = z.infer<typeof StepAnswerRequestSchema>;

/** `state/onboarding/progress.json`. */
export const ProgressSchema = z.strictObject({
  format: z.literal(1),
  steps: z.record(
    z.string(),
    z.strictObject({ state: StepStateSchema, at: InstantSchema, linked: z.literal(true).optional() }),
  ),
});
export type Progress = z.infer<typeof ProgressSchema>;

export const ONBOARDING_CODES = { unknownStep: 'onboarding_unknown_step' } as const;
