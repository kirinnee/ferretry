import { expect, test } from 'bun:test';
import { subtreeHost } from '../support/round-two.ts';

/** Each declared route, a body that reaches its handler, and the answer THAT handler gives a ferret the session store does not hold. */
const ROUTES: readonly (readonly [method: string, path: string, body: unknown, status: number, code?: string])[] = [
  ['POST', '/v1/ferrets/lead/fork', {}, 400],
  ['POST', '/v1/ferrets/lead/handover', {}, 400],
  ['GET', '/v1/ferrets/lead/handover', undefined, 404],
  ['POST', '/v1/ferrets/lead/handover/cancel', {}, 400, 'missing_request_id'],
  ['GET', '/v1/ferrets/lead/relaunch-settings', undefined, 404, 'not-found'],
  ['POST', '/v1/ferrets/lead/conversion-preview', { agent: 'x' }, 404, 'not-found'],
  ['POST', '/v1/ferrets/lead/move', { agent: 'x' }, 400, 'missing_request_id'],
  ['POST', '/v1/ferrets/lead/move/ask-to-stop-jobs', {}, 404, 'not-found'],
];

test('moves wiring: every declared fork, handover and move route is built once and mounted on the daemon half', async () => {
  // Arrange
  const { h } = await subtreeHost();
  const answered: (readonly [string, number, string | undefined])[] = [];

  // Act
  for (const [method, path, body] of ROUTES) {
    const response = await h.request(method, path, body === undefined ? {} : { body });
    answered.push([`${method} ${path}`, response.status, response.json<{ code?: string }>().code]);
  }

  // Assert
  expect(answered.map(([key, status]) => [key, status])).toEqual(
    ROUTES.map(([m, p, , status]) => [`${m} ${p}`, status]),
  );
  for (const [index, [, , , , code]] of ROUTES.entries())
    if (code !== undefined) expect(answered[index]?.[2]).toBe(code);
  await h.stop();
});

test('moves wiring: the handover receipt is read through its declared state file and an absent one is a plain 404', async () => {
  // Arrange
  const { h } = await subtreeHost();

  // Act
  const response = await h.request('GET', '/v1/ferrets/lead/handover', {});

  // Assert: the receipt is read through the declared state file, so an absent one is a plain 404, not a crash
  expect(response.status).toBe(404);
  await h.stop();
});
