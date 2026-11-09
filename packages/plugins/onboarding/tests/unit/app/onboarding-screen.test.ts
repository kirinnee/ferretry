import { describe, expect, it } from 'bun:test';
import type { EventDef } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import app from '../../../app/index.ts';
import { LINK_COSTS } from '../../../app/link-costs.ts';
import { onboardingScreen } from '../../../app/onboarding-screen.ts';
import { ONBOARDING_CODES, OnboardingChanged } from '../../../contract/index.ts';
import { linkCosts } from '../../../cli/lib/words.ts';

interface Sent {
  readonly route: string;
  readonly init?: { params?: Record<string, string>; body?: unknown };
}

function fakeClient(answers: Record<string, unknown>) {
  const sent: Sent[] = [];
  const listeners: ((payload: never) => void)[] = [];
  const client: PluginClient = {
    async call<Answer>(route: string, init?: Sent['init']): Promise<Answer> {
      sent.push({ route, ...(init === undefined ? {} : { init }) });
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return answer as Answer;
    },
    subscribe<Name extends string, Payload>(event: EventDef<Name, Payload>, listener: (payload: Payload) => void) {
      expect(String(event.name)).toBe(OnboardingChanged.name);
      listeners.push(listener as (payload: never) => void);
      return () => {
        listeners.splice(listeners.indexOf(listener as never), 1);
      };
    },
  };
  return { client, sent, listeners };
}

const VIEW = {
  steps: [{ plugin: 'logins', id: 'login', title: 'Sign in', order: 30, state: 'pending' as const }],
  complete: false,
};

describe('the onboarding screen', () => {
  it('loads the view through GET /v1/onboarding and refuses a shape it does not know', async () => {
    const good = fakeClient({ 'GET /v1/onboarding': VIEW });
    expect(await onboardingScreen(good.client).load()).toEqual(VIEW);
    const bad = fakeClient({ 'GET /v1/onboarding': { steps: 'none' } });
    await expect(onboardingScreen(bad.client).load()).rejects.toThrow();
  });

  it('records an answer on the step route with the plugin and step in the path', async () => {
    const fake = fakeClient({
      'POST /v1/onboarding/steps/:plugin/:stepId': { ...VIEW.steps[0], state: 'done', at: '2026-11-06T09:00:00.000Z' },
    });
    const recorded = await onboardingScreen(fake.client).answer('logins', 'login', { state: 'done' });
    expect(recorded?.state).toBe('done');
    expect(fake.sent[0]).toEqual({
      route: 'POST /v1/onboarding/steps/:plugin/:stepId',
      init: { params: { plugin: 'logins', stepId: 'login' }, body: { state: 'done' } },
    });
  });

  it('an unknown step is undefined; any other refusal is thrown', async () => {
    const unknown = Object.assign(new Error('no such step'), { code: ONBOARDING_CODES.unknownStep });
    const first = fakeClient({ 'POST /v1/onboarding/steps/:plugin/:stepId': unknown });
    expect(await onboardingScreen(first.client).answer('x', 'y', { state: 'later' })).toBeUndefined();
    const second = fakeClient({ 'POST /v1/onboarding/steps/:plugin/:stepId': new Error('503') });
    await expect(onboardingScreen(second.client).answer('x', 'y', { state: 'later' })).rejects.toThrow('503');
  });

  it('reset calls the reset route', async () => {
    const fake = fakeClient({});
    await onboardingScreen(fake.client).reset();
    expect(fake.sent.map(each => each.route)).toEqual(['POST /v1/onboarding/reset']);
  });

  it('subscribes to the redraw event and stops when told to', () => {
    const fake = fakeClient({});
    let redraws = 0;
    const stop = onboardingScreen(fake.client).subscribe(() => {
      redraws += 1;
    });
    fake.listeners[0]?.({ plugin: 'logins', step: 'login' } as never);
    expect(redraws).toBe(1);
    stop();
    expect(fake.listeners).toHaveLength(0);
  });

  it('the half declares exactly the manifest screens: the daemon-less first run and the per-machine steps', () => {
    const fake = fakeClient({ 'GET /v1/onboarding': VIEW });
    const half = app.build?.({ manifest: app.manifest, client: fake.client });
    expect(Object.keys(half?.screens ?? {}).sort()).toEqual(['onboarding', 'steps']);
    // `onboarding` is daemon-less: the shell draws it from `shell.daemonless`, never from a machine's half.
    expect(half?.screens.onboarding({ params: {} })).toBeNull();
    expect(app.manifest.ui?.screens?.filter(screen => screen.daemonless === true).map(screen => screen.id)).toEqual([
      'onboarding',
    ]);
    const make = (app as unknown as { shell: { daemonless: (ports: unknown) => Record<string, unknown> } }).shell
      .daemonless;
    expect(Object.keys(make({}))).toEqual(['onboarding']);
  });

  it('says the linked sign-in costs in one line, the same words as the terminal', () => {
    expect(LINK_COSTS).toBe(linkCosts('fy'));
    expect(LINK_COSTS).not.toContain('\n');
  });
});
