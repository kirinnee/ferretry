/**
 * @ferretry/plugin-onboarding/contract — wire schemas, port + token, events, state, words.
 * Onboarding lists the steps every plugin declared in its manifest (the post-build snapshot) and remembers where each
 * stands (§6.1). It offers no hook: a step's live check is a route its owning plugin declares, which the app calls.
 */
import { defineEvent, definePort, defineState, type Word } from '@ferretry/kernel/contract';
import { z } from 'zod';
import {
  type OnboardingView,
  ProgressSchema,
  type StepAnswerRequest,
  StepIdSchema,
  StepPluginSchema,
  type StepView,
} from './wire.ts';

export * from './wire.ts';
export * from './slots.ts';

export const ONBOARDING_WORDS: readonly Word[] = [
  { word: 'step', means: 'one thing the first run does: find, ask or leave for later', insteadOf: [] },
];

// ─── port ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface OnboardingApi {
  /** The steps in order, from the snapshot, with where each stands. */
  view(): Promise<OnboardingView>;
  /** Records how the owner (or the app, after a step's live check) answered. */
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

// ─── audit kinds ─────────────────────────────────────────────────────────────────────────────────────────────────

export const ONBOARDING_AUDIT = { reset: 'fleet.configured:onboarding-reset' } as const;
