import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import daemon from '../../../../daemon/index.ts';

describe('the composer action (G33, design D2 #7: Conversation owns it, with Terminals and Gate)', () => {
  // G33's behaviour (acts only while the composer holds exactly the quoted draft; no ledger row; no text logged) is
  // proved against the harness seam in harness-seam.test.ts ("G33 …").
  test('a Ferrets that offers no terminal seam refuses plugin_unavailable, and writes no ledger row', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('f1') });
    const host = await testHost({
      plugins: [daemon],
      fakes: { ferrets, asks: new FakeAsks() },
      clock: fixedClock('2026-11-07T09:00:00Z'),
    });
    const response = await host.request('POST', '/v1/ferrets/f1/composer', {
      as: owner(),
      body: { action: 'submit', draft: 'hello there' },
    });
    expect([response.status, response.json<{ code: string }>().code]).toEqual([503, 'plugin_unavailable']);
    const sends = await host.request('GET', '/v1/ferrets/f1/sends', { as: owner() });
    expect(sends.json<{ sends: unknown[] }>().sends).toEqual([]);
    expect(JSON.stringify(host.logs)).not.toContain('hello there');
    await host.stop();
  });
});
