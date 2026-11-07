import { expect, test } from 'bun:test';
import type { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import { subtreeHost } from '../support/round-two.ts';
test('G24 the live subtree route masks whole excerpts before cutting and bounds row lookups', async () => {
  const { h, looked, masker, peak } = await subtreeHost();
  const response = await h.request('GET', '/v1/ferrets/lead/subtree');
  expect(response.status).toBe(200);
  const view = response.json<{ rows: { last?: { text: string } }[] }>();
  expect(view.rows).toHaveLength(70);
  expect(looked).toHaveLength(64);
  expect(peak()).toBe(4);
  expect((masker as FakeRedaction).opens).toBe(1);
  expect(view.rows.filter(row => row.last)).toHaveLength(64);
  expect(view.rows[0]?.last?.text).not.toContain('fixt');
  expect(view.rows[0]?.last?.text).toContain('[red');
  expect((await h.request('GET', '/v1/ferrets/missing/subtree')).status).toBe(404);
  await h.stop();
});

test('G24 the live subtree route withholds excerpts when Vault redaction cannot run', async () => {
  const { h } = await subtreeHost({
    read: async () => {
      throw new Error('locked');
    },
  });
  const response = await h.request('GET', '/v1/ferrets/lead/subtree');
  expect(response.status).toBe(200);
  expect(response.body).toContain('[excerpt withheld]');
  expect(response.body).not.toContain('fixture-secret');
  await h.stop();
});

test('G24 subtree lineage refuses an unrelated ferret caller', async () => {
  const { h } = await subtreeHost();
  expect(
    (await h.request('GET', '/v1/ferrets/stranger/subtree', { headers: { 'x-test-ferret': 'lead' } })).status,
  ).toBe(403);
  expect((await h.request('GET', '/v1/ferrets/lead/subtree', { headers: { 'x-test-ferret': 'lead' } })).status).toBe(
    200,
  );
  await h.stop();
});
