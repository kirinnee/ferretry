import { describe, expect, test } from 'bun:test';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { fixedClock, testHost } from '@ferretry/kernel/testing';
import {
  ONBOARDING_CODES,
  ONBOARDING_PROGRESS,
  OnboardingChanged,
  OnboardingPort,
  OnboardingViewSchema,
  StepViewSchema,
} from '../../contract/index.ts';
import { onboardingConformance } from '../../contract/testing/index.ts';
import onboarding from '../../daemon/index.ts';

/** A data-only plugin that declares first-run steps the way the owning plugins' manifests do. */
function stepper(id: string, steps: readonly { id: string; title: string; order: number }[]) {
  return implementDaemon(
    definePlugin({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: ['command'], onboarding: steps }),
    { build: () => ({}) },
  );
}

const harnesses = stepper('claude-code', [{ id: 'harness', title: 'Claude Code', order: 20 }]);
const logins = stepper('logins', [{ id: 'login', title: 'Sign in', order: 30 }]);
const shells = stepper('shells', [{ id: 'nix', title: 'Shells', order: 80 }]);

const boot = () =>
  testHost({ plugins: [shells, logins, harnesses, onboarding], clock: fixedClock('2026-11-06T09:00:00.000Z') });

/*
 * GAP(kernel-testing): the in-memory test store (`packages/core/kernel/testing/state.ts` parseDocument) strips `format`
 * and validates the bare document only, while the real store (`host/state/format.ts` shapeOf) also tries a schema that
 * names `format` (as `ProgressSchema` does, frozen contract). So a SECOND read or write of `progress.json` is judged
 * damaged here. Cases that need one are `test.todo` below and are covered against a faithful store in
 * tests/unit/daemon/service.test.ts.
 */
describe('onboarding daemon half', () => {
  test('GET /v1/onboarding lists the snapshot steps in order, all pending, not complete', async () => {
    const host = await boot();
    const response = await host.request('GET', '/v1/onboarding');
    expect(response.status).toBe(200);
    const view = OnboardingViewSchema.parse(response.json());
    expect(view.steps.map(step => `${step.plugin}:${step.id}`)).toEqual([
      'claude-code:harness',
      'logins:login',
      'shells:nix',
    ]);
    expect(view.steps.every(step => step.state === 'pending')).toBe(true);
    expect(view.complete).toBe(false);
  });

  test('an answer is recorded with the clock time and announced', async () => {
    const host = await boot();
    const response = await host.request('POST', '/v1/onboarding/steps/logins/login', { body: { state: 'found' } });
    expect(response.status).toBe(200);
    expect(StepViewSchema.parse(response.json())).toMatchObject({
      plugin: 'logins',
      id: 'login',
      state: 'found',
      at: '2026-11-06T09:00:00.000Z',
    });
    expect(host.published).toContainEqual({
      event: OnboardingChanged.name,
      payload: { plugin: 'logins', step: 'login' },
    });
  });

  test('an answer for a step no plugin declared is 404 onboarding_unknown_step and writes nothing', async () => {
    const host = await boot();
    const response = await host.request('POST', '/v1/onboarding/steps/logins/nope', { body: { state: 'done' } });
    expect(response.status).toBe(404);
    expect(response.json<{ code: string }>().code).toBe(ONBOARDING_CODES.unknownStep);
    expect(host.state('onboarding').raw(ONBOARDING_PROGRESS)).toBeUndefined();
  });

  test('an answer other than found, done, later or skipped is refused as 400', async () => {
    const host = await boot();
    for (const body of [{ state: 'pending' }, { state: 'done', extra: 1 }, {}])
      expect((await host.request('POST', '/v1/onboarding/steps/logins/login', { body })).status).toBe(400);
  });

  test('reset answers 204 with no body', async () => {
    const host = await boot();
    const response = await host.request('POST', '/v1/onboarding/reset');
    expect(response.status).toBe(204);
    expect(response.body).toBe('');
  });

  test('a damaged progress.json is answered 503 store_damaged, never as an empty run', async () => {
    const host = await boot();
    host.state('onboarding').plant(ONBOARDING_PROGRESS, '{ not json');
    const response = await host.request('GET', '/v1/onboarding');
    expect(response.status).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('store_damaged');
  });

  test('the provided port passes the contract conformance suite', async () => {
    const host = await boot();
    expect((await onboardingConformance(() => host.provided(OnboardingPort))).ok).toBe(true);
  });

  test.todo('an answered step shows on the next read, and every step answered completes the run (kernel-testing GAP)');
  test.todo('reset forgets every answer and announces each step it cleared (kernel-testing GAP)');
  test.todo('progress survives a daemon restart (kernel-testing GAP)');
});
