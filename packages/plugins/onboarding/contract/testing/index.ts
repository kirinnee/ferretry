/** @ferretry/plugin-onboarding/contract/testing — the fake and the conformance suite (§7.8). */
import { err, ok, type Result } from '@ferretry/std';
import {
  type OnboardingApi,
  type OnboardingView,
  OnboardingViewSchema,
  type StepAnswerRequest,
  type StepView,
} from '../index.ts';

export interface FakeOnboarding extends OnboardingApi {
  add(step: Omit<StepView, 'state'> & { state?: StepView['state'] }): void;
}

export function fakeOnboarding(): FakeOnboarding {
  const steps: StepView[] = [];
  const find = (plugin: string, id: string) => steps.find(step => step.plugin === plugin && step.id === id);
  const view = (): OnboardingView => ({
    steps: [...steps].sort((a, b) => a.order - b.order),
    complete: steps.every(step => step.state !== 'pending' && step.state !== 'asked'),
  });
  return {
    view: async () => view(),
    find: async (plugin, step) => find(plugin, step),
    answer: async (plugin, step, answer: StepAnswerRequest) => {
      const found = find(plugin, step);
      if (found === undefined) return undefined;
      const next: StepView = { ...found, state: answer.state };
      steps.splice(steps.indexOf(found), 1, next);
      return next;
    },
    reset: async () => {
      for (const [index, step] of steps.entries()) steps[index] = { ...step, state: 'pending' };
    },
    add: step => {
      steps.push({ state: 'pending', ...step });
    },
  };
}

/** What every implementation of `OnboardingApi` must satisfy. */
export async function onboardingConformance(make: () => OnboardingApi): Promise<Result<true, readonly string[]>> {
  const failures: string[] = [];
  const api = make();
  if (!OnboardingViewSchema.safeParse(await api.view()).success) failures.push('view() returns an OnboardingView');
  if ((await api.find('no-such-plugin', 'no-such-step')) !== undefined)
    failures.push('find() of an unknown step is undefined');
  if ((await api.answer('no-such-plugin', 'no-such-step', { state: 'done' })) !== undefined)
    failures.push('answer() of an unknown step is undefined');
  return failures.length === 0 ? ok(true) : err(failures);
}
