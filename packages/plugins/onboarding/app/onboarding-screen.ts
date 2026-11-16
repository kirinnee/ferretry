/**
 * The 'onboarding' screen's controller: where each first-run step stands, recorded through this plugin's routes.
 * Framework-free (the shell renders it): load, answer, reset, and a subscription to the daemon's redraw event.
 *
 * A step's LIVE CHECK is a route its owning plugin declares, which the screen's page calls; this controller only
 * records what the page concluded.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  ONBOARDING_CODES,
  OnboardingChanged,
  type OnboardingView,
  OnboardingViewSchema,
  type StepAnswerRequest,
  type StepView,
  StepViewSchema,
} from '../contract/index.ts';

export interface OnboardingScreen {
  load(): Promise<OnboardingView>;
  /** `undefined` when the daemon does not know the step (its plugin was turned off meanwhile). */
  answer(plugin: string, step: string, answer: StepAnswerRequest): Promise<StepView | undefined>;
  reset(): Promise<void>;
  /** Calls `listener` after any step changes anywhere; returns the way to stop listening. */
  subscribe(listener: () => void): () => void;
}

const isUnknownStep = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === ONBOARDING_CODES.unknownStep;

export function onboardingScreen(client: PluginClient): OnboardingScreen {
  return {
    async load() {
      return OnboardingViewSchema.parse(await client.call('GET /v1/onboarding'));
    },
    async answer(plugin, step, answer) {
      try {
        return StepViewSchema.parse(
          await client.call('POST /v1/onboarding/steps/:plugin/:stepId', {
            params: { plugin, stepId: step },
            body: answer,
          }),
        );
      } catch (error: unknown) {
        if (isUnknownStep(error)) return undefined;
        throw error;
      }
    },
    async reset() {
      await client.call('POST /v1/onboarding/reset');
    },
    subscribe: listener => client.subscribe(OnboardingChanged, () => listener()),
  };
}
