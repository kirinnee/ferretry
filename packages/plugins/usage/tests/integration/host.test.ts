import { describe, expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import usage from '../../daemon/index.ts';

async function host() {
  return await testHost({
    plugins: [usage],
    fakes: {
      ferrets: new FakeFerrets(),
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
      vault: new FakeVault(),
    },
  });
}

describe('the usage daemon half on the test host', () => {
  test('it builds and answers the budget standing with no budget set', async () => {
    const h = await host();
    const answer = await h.request('GET', '/v1/usage/budgets');
    expect(answer.status).toBe(200);
    expect(answer.json()).toEqual({ budgets: [] });
    await h.stop();
  });

  test('the public feed is not served while the machine has not opted in', async () => {
    const h = await host();
    expect((await h.request('GET', '/usage')).status).toBe(404);
    expect((await h.request('GET', '/metrics')).status).toBe(404);
    await h.stop();
  });

  test('a signed-in reader gets the feed with one row per login', async () => {
    const h = await host();
    const answer = await h.request('GET', '/v1/usage');
    expect(answer.status).toBe(200);
    expect(answer.json<{ accounts: { agent: string }[] }>().accounts.map(row => row.agent)).toEqual(['work']);
    await h.stop();
  });
});
