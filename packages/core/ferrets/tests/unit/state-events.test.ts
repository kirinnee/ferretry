import { expect, test } from 'bun:test';
import { FerretsChanged, FerretsPort } from '../../contract/index.ts';
import { ferretId } from '../../contract/testing/index.ts';
import { subtreeHost } from '../support/round-two.ts';
test('I108 a daemon stop publishes the stopped state for Vault', async () => {
  const { h } = await subtreeHost();
  const response = await h.request('POST', '/v1/ferrets/lead/stop', { body: {} });
  expect(response.status).toBe(200);
  expect(h.published.filter(event => event.event === FerretsChanged.name).at(-1)?.payload).toMatchObject({
    ferret: 'lead',
    state: 'stopped',
  });
  expect(await h.provided(FerretsPort).get(ferretId('lead'))).toMatchObject({ state: 'stopped' });
  await h.stop();
});
