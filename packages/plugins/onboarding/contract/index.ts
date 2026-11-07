/**
 * @ferretry/plugin-onboarding/contract — wire schemas, the step kind (§4.12), port + token, events, state, words.
 * Onboarding OFFERS the `onboarding` step kind: other plugins add steps through their manifests' `onboarding` list.
 */
import { defineEvent, defineHook, definePort, defineState, type Word } from '@ferretry/kernel/contract';
import { z } from 'zod';
import {
  type OnboardingView,
  ProgressSchema,
  type StepAnswerRequest,
  type StepFound,
  StepFoundSchema,
  StepIdSchema,
  StepPluginSchema,
  type StepView,
  type StepAsk,
  StepAskSchema,
} from './wire.ts';

export * from './wire.ts';

export const ONBOARDING_WORDS: readonly Word[] = [
  { word: 'step', means: 'one thing the first run does: find, ask or leave for later', insteadOf: [] },
];

// ─── the step kind (§4.12) ───────────────────────────────────────────────────────────────────────────────────────

/**
 * What a plugin's step does. `find` detects something already on the machine (a signed-in harness, nix, a folder);
 * `ask` is the smallest question if `find` found nothing; `later` names the moment it will ask instead.
 * A step whose `find` found it needs no question.
 */
export interface OnboardingStep {
  readonly id: string;
  find?(): Promise<StepFound>;
  ask?(): Promise<StepAsk>;
  readonly later?: string;
}

/**
 * The hook a step's CODE reaches Onboarding through (contribute). The step's id, title and order are manifest
 * metadata (`manifest.onboarding`) and need no hook; only a `find`/`ask` that RUNS does.
 *
 * OPEN QUESTION FOR THE LEAD: this hook is not in the §3.5 table, and taking it would be a plugin → plugin contract
 * edge (every plugin with a step would import this contract), which spine.md §4 rule 3 allows only for Usage → Logins
 * and Packs → Runtimes. Until the lead decides (core hook, or the edge), plugins declare steps as manifest metadata
 * only and Onboarding lists them without running their `find`.
 */
export const OnboardingSteps = defineHook('onboarding.steps', {
  mode: 'contribute',
  item: z.custom<OnboardingStep>(),
});

// ─── port ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface OnboardingApi {
  /** The steps in order with where each stands. */
  view(): Promise<OnboardingView>;
  /** Runs one step's `find` (reads only). */
  find(plugin: string, step: string): Promise<StepView | undefined>;
  /** Records how the owner answered. */
  answer(plugin: string, step: string, answer: StepAnswerRequest): Promise<StepView | undefined>;
  reset(): Promise<void>;
}
export const OnboardingPort = definePort<OnboardingApi>('onboarding');
export const ONBOARDING_READ_MODELS = ['view'] as const;

// ─── events ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A step's state changed (after its write): every open first-run screen redraws. */
export const OnboardingChanged = defineEvent(
  'onboarding.changed',
  z.strictObject({ plugin: StepPluginSchema, step: StepIdSchema }),
);

// ─── state (§9.2) ────────────────────────────────────────────────────────────────────────────────────────────────

export const ONBOARDING_PROGRESS = defineState({
  name: 'progress',
  path: 'progress.json',
  store: 'json',
  format: 1,
  schema: ProgressSchema,
});

export { StepAskSchema, StepFoundSchema };

// ─── audit kinds ─────────────────────────────────────────────────────────────────────────────────────────────────

export const ONBOARDING_AUDIT = { reset: 'fleet.configured:onboarding-reset' } as const;
