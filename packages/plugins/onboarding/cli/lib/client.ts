import { ONBOARDING_CODES, OnboardingViewSchema, StepViewSchema } from '../../contract/index.ts';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { OnboardClient } from './ports.ts';

/** This plugin's three routes, and a read of any other plugin's declared route, through the shell's client. */
export function onboardClient(client: PluginClient): OnboardClient {
  return {
    async view() {
      return OnboardingViewSchema.parse(await client.call('GET /v1/onboarding'));
    },
    async record(plugin, id, answer) {
      try {
        const recorded = await client.call('POST /v1/onboarding/steps/:plugin/:stepId', {
          params: { plugin, stepId: id },
          body: answer,
        });
        return StepViewSchema.parse(recorded);
      } catch (error: unknown) {
        if (isUnknownStep(error)) return undefined;
        throw error;
      }
    },
    async reset() {
      await client.call('POST /v1/onboarding/reset');
    },
    check: route => client.call(route),
  };
}

const isUnknownStep = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === ONBOARDING_CODES.unknownStep;
