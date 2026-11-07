import { expect, test } from 'bun:test';
import { FerretFiles } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { host } from './route-fixture.ts';

test('R-0332 a start accepts and preserves the harness conversation approved by the launch contract', async () => {
  const runner = new FakeRunner();
  const h = await host([], { harness: new FakeHarness(), runner });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'conversation' },
    body: { folder: '/work/a', harnessConversation: 'conversation-existing' },
  });
  expect(started.status).toBe(201);
  const id = started.json<{ id: string }>().id;
  expect(JSON.parse(h.state('ferrets').raw(FerretFiles, id) ?? '{}')).toMatchObject({
    harnessConversation: 'conversation-existing',
  });
  for (const harnessConversation of ['', 'c'.repeat(257)]) {
    const answer = await h.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': 'invalid-conversation' },
      body: { folder: '/work/a', harnessConversation },
    });
    expect(answer.status).toBe(400);
  }
  expect(runner.starts).toBe(1);
});
