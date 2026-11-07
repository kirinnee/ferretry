import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import daemon from '../../../../daemon/index.ts';

describe('the composer action (G33, design D2 #7: Conversation owns it, with Terminals and Gate)', () => {
  test.skip('G33 acts only while the composer holds exactly the quoted draft, writes no ledger row, and audits mode composer without the text — pending port: Ferrets deliver seam', () => {});

  test('until the deliver seam lands it refuses with the terminal sentence, and writes no ledger row', async () => {
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
    expect([response.status, response.json<{ code: string }>().code]).toEqual([
      503,
      'conversation_terminal_unavailable',
    ]);
    const sends = await host.request('GET', '/v1/ferrets/f1/sends', { as: owner() });
    expect(sends.json<{ sends: unknown[] }>().sends).toEqual([]);
    expect(JSON.stringify(host.logs)).not.toContain('hello there');
    await host.stop();
  });
});
