import { describe, expect, test } from 'bun:test';
import { type FerretId } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import usage from '../../daemon/index.ts';

// M4: Usage reads what a ferret spent THROUGH Ferrets' `turnUsage` (the harness is Ferrets' to name). A ferret whose
// turns can be read is evidence; one that cannot is "unknown", never zero.

const host = async (ferrets: FakeFerrets) =>
  await testHost({
    plugins: [usage],
    fakes: {
      ferrets,
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
      vault: new FakeVault(),
    },
  });

const tokensOf = async (h: Awaited<ReturnType<typeof host>>, ferret: FerretId) => {
  await h.runJob('usage-ingest');
  const answer = await h.request('GET', '/v1/usage/insights', { query: { q: 'sum by (token_data)', session: ferret } });
  return answer.json();
};

describe('M4 Usage reads a ferret’s turns through Ferrets', () => {
  test('a stopped ferret whose harness reports turns has its tokens counted (token_data known)', async () => {
    const ferrets = new FakeFerrets();
    const id = ferretId('writer');
    ferrets.add({ id, state: 'stopped', login: 'work' });
    ferrets.setTurnUsage(id, [{ turn: 1, at: T0, model: 'claude-sonnet-4-5', inputTokens: 1200, outputTokens: 300 }]);
    const h = await host(ferrets);
    const answer = JSON.stringify(await tokensOf(h, id));
    expect(answer).toContain('"known"');
    expect(answer).not.toContain('"unknown"');
    await h.stop();
  });

  test('a ferret Ferrets cannot read is unknown, never zero', async () => {
    const ferrets = new FakeFerrets();
    const id = ferretId('ghost');
    ferrets.add({ id, state: 'stopped', login: 'work' });
    ferrets.forgetTurnUsage(id);
    const h = await host(ferrets);
    const answer = JSON.stringify(await tokensOf(h, id));
    expect(answer).toContain('"unknown"');
    await h.stop();
  });
});
