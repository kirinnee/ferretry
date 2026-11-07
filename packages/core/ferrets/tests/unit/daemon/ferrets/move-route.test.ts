import { expect, test } from 'bun:test';
import { as, host, record } from './route-fixture.ts';

const MOVE_ROUTES = ['move', 'move/ask-to-stop-jobs'] as const;

test('a ferret reaches the move routes of itself and its helpers only, as the resume route does', async () => {
  const h = await host([record('lead'), record('child', 'lead'), record('stranger')]);
  for (const route of MOVE_ROUTES) {
    // Another ferret's move is refused before the moves module is asked anything.
    const refused = await h.request('POST', `/v1/ferrets/stranger/${route}`, { ...as('lead'), body: {} });
    expect(refused.status).toBe(403);
    expect(refused.json<{ code: string }>().code).toBe('forbidden');
    const upward = await h.request('POST', `/v1/ferrets/lead/${route}`, { ...as('child'), body: {} });
    expect(upward.status).toBe(403);
    // Its own and its helper's reach the moves module, which answers in its own words (not 403).
    for (const target of ['lead', 'child']) {
      const reached = await h.request('POST', `/v1/ferrets/${target}/${route}`, { ...as('lead'), body: {} });
      expect(reached.status).not.toBe(403);
    }
  }
  await h.stop();
});

test('a person reaches the move routes of any ferret', async () => {
  const h = await host([record('lead'), record('stranger')]);
  for (const route of MOVE_ROUTES) {
    const reached = await h.request('POST', `/v1/ferrets/stranger/${route}`, { body: {} });
    expect(reached.status).not.toBe(403);
  }
  await h.stop();
});
