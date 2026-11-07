import { describe, expect, test } from 'bun:test';
import type { CallStanding } from '../../../contract/route.ts';
import { currentActor, currentStanding, runInCall } from '../../../host/call-scope.ts';

const standing = { actor: 'admin-cli' } as unknown as CallStanding;

describe('the call scope carries the standing next to the actor (config-write judge)', () => {
  test('inside a call the standing admission put on it is read across awaits', async () => {
    const seen = await runInCall({ actor: 'owner-tools', standing }, async () => {
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      return { actor: currentActor(), standing: currentStanding() };
    });
    expect(seen.actor).toBe('owner-tools');
    expect(seen.standing).toBe(standing);
  });

  test('outside a call (a job) there is no standing, and the actor is ferret', () => {
    expect(currentStanding()).toBeUndefined();
    expect(currentActor()).toBe('ferret');
  });

  test('a call that carries no standing (a member call) reads none', async () => {
    expect(await runInCall({ actor: 'owner-viewer' }, async () => currentStanding())).toBeUndefined();
  });
});
