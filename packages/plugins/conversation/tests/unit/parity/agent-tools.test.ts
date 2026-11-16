/** Parity row T-0038 (docs/design/rebuild-parity.tsv): the `search_work` agent tool, finding cards and asks. */
import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { fixedClock, testHost } from '@ferretry/kernel/testing';
import daemon from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';

describe('the agent tools Conversation owns', () => {
  test('T-0038 search_work is declared, and answers a query as lines a model reads', async () => {
    expect(manifest.actions.agentTools.map(tool => tool.name)).toContain('search_work');
    const host = await testHost({
      plugins: [daemon],
      fakes: { ferrets: new FakeFerrets(), asks: new FakeAsks() },
      clock: fixedClock('2026-11-07T09:00:00Z'),
    });
    const answer = await host.tool('search_work', { query: 'relay carrier' });
    expect(answer.isError).not.toBe(true);
    expect(typeof answer.text).toBe('string');
    expect(answer.data).toMatchObject({ hits: [], total: 0 });
    const refused = await host.tool('search_work', { query: '' });
    expect(refused.isError).toBe(true);
    await host.stop();
  });
});
