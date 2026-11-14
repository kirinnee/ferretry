import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import usage from '../../daemon/index.ts';

// A ferret converted from v4 has no transcript this daemon can read, but its own documents still say which model it was
// started on and how many turns it took (`config.json` model, `state.json` turn). Insights must show both: "unknown
// model" and 0 turns for every converted session was the bug (round-2 sweep item R2-4).

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

const ask = async (h: Awaited<ReturnType<typeof host>>, q: string, session: string) => {
  await h.runJob('usage-ingest');
  const answer = await h.request('GET', '/v1/usage/insights', { query: { q, session } });
  return JSON.stringify(await answer.json());
};

describe('insights keep what a ferret’s own documents say', () => {
  test('a stopped ferret with no readable transcript still shows its selected model and its turn count', async () => {
    const ferrets = new FakeFerrets();
    const id = ferretId('converted');
    ferrets.add({ id, state: 'stopped', login: 'work', model: 'claude-opus-5-5' });
    ferrets.forgetTurnUsage(id);
    ferrets.setIngestEvidence(id, { selectedModel: 'claude-opus-5-5', turns: 6, startedAt: T0 });
    const h = await host(ferrets);
    const byModel = await ask(h, 'sum(turns) by (model)', id);
    expect(byModel).toContain('claude-opus-5-5');
    expect(byModel).not.toContain('unknown');
    expect(await ask(h, 'sum(turns)', id)).toContain('6');
    await h.stop();
  });

  test('a ferret whose documents say nothing keeps null turns, never a zero', async () => {
    const ferrets = new FakeFerrets();
    const id = ferretId('bare');
    ferrets.add({ id, state: 'stopped', login: 'work' });
    ferrets.forgetTurnUsage(id);
    const h = await host(ferrets);
    expect(await ask(h, 'sum(turns) by (model)', id)).not.toContain('claude-opus-5-5');
    await h.stop();
  });
});
