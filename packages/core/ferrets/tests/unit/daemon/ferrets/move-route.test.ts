import { expect, test } from 'bun:test';
import { as, host, record } from './route-fixture.ts';

/** Every move-family route and its method: all act on, or read the conversation of, the ferret they name. */
const MOVE_ROUTES = [
  ['POST', 'move'],
  ['POST', 'move/ask-to-stop-jobs'],
  // A person's route (`caller: 'person'`): the kernel refuses a ferret before the handler, and `mayAct` guards it too.
  ['POST', 'fork'],
  ['POST', 'handover'],
  ['GET', 'handover'],
  ['POST', 'handover/cancel'],
  ['GET', 'relaunch-settings'],
  ['POST', 'conversion-preview'],
] as const;

test('a ferret reaches the move routes of itself and its helpers only, as the resume route does', async () => {
  const h = await host([record('lead'), record('child', 'lead'), record('stranger')]);
  for (const [method, route] of MOVE_ROUTES) {
    // Another ferret's move is refused before the moves module is asked anything.
    const refused = await h.request(method, `/v1/ferrets/stranger/${route}`, { ...as('lead'), body: {} });
    expect(refused.status).toBe(403);
    expect(refused.json<{ code: string }>().code).toBe(route === 'fork' ? 'owner_only' : 'forbidden');
    const upward = await h.request(method, `/v1/ferrets/lead/${route}`, { ...as('child'), body: {} });
    expect(upward.status).toBe(403);
    // Its own and its helper's reach the moves module, which answers in its own words: never Ferrets' own `forbidden`
    // (the handover module keeps its own owner-only rule for a helper, which is a different refusal).
    for (const target of route === 'fork' ? [] : ['lead', 'child']) {
      const reached = await h.request(method, `/v1/ferrets/${target}/${route}`, { ...as('lead'), body: {} });
      expect(reached.json<{ code?: string }>().code).not.toBe('forbidden');
    }
  }
  await h.stop();
});

test('a person reaches the move routes of any ferret', async () => {
  const h = await host([record('lead'), record('stranger')]);
  for (const [method, route] of MOVE_ROUTES) {
    const reached = await h.request(method, `/v1/ferrets/stranger/${route}`, { body: {} });
    expect(reached.json<{ code?: string }>().code).not.toBe('forbidden');
  }
  await h.stop();
});
