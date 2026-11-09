import { describe, expect, test } from 'bun:test';
import { StepAnswerRequestSchema } from '../../contract/index.ts';
import { fakeOnboarding, onboardingConformance } from '../../contract/testing/index.ts';
import manifest from '../../manifest.ts';

describe('onboarding contract', () => {
  test('the fake passes the conformance suite', async () => {
    expect((await onboardingConformance(fakeOnboarding)).ok).toBe(true);
  });

  test('the fake orders steps and records answers', async () => {
    const onboarding = fakeOnboarding();
    onboarding.add({ plugin: 'codex', id: 'harness', title: 'Codex', order: 21 });
    onboarding.add({ plugin: 'claude-code', id: 'harness', title: 'Claude Code', order: 20 });
    expect((await onboarding.view()).steps.map(step => step.plugin)).toEqual(['claude-code', 'codex']);
    await onboarding.answer('codex', 'harness', { state: 'later' });
    expect((await onboarding.view()).steps[1]?.state).toBe('later');
  });

  test('an answer is done, later or skipped; never found or asked', () => {
    expect(StepAnswerRequestSchema.safeParse({ state: 'later' }).success).toBe(true);
    expect(StepAnswerRequestSchema.safeParse({ state: 'pending' }).success).toBe(false);
  });

  test('n1 only a found answer can say it is the terminal’s own sign-in', () => {
    expect(StepAnswerRequestSchema.safeParse({ state: 'found', linked: true }).success).toBe(true);
    expect(StepAnswerRequestSchema.safeParse({ state: 'done', linked: true }).success).toBe(false);
    expect(StepAnswerRequestSchema.safeParse({ state: 'found', linked: false }).success).toBe(false);
  });

  test('recording an answer is a person act, and the plugin offers no hook', () => {
    const answer = manifest.actions.routes.find(route => route.key === 'POST /v1/onboarding/steps/:plugin/:stepId');
    expect(answer?.caller).toBe('person');
    expect('hooks' in manifest).toBe(false);
  });
});
