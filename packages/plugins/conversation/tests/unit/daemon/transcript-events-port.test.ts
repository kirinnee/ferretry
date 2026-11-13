import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { fixedClock, testHost } from '@ferretry/kernel/testing';
import { ConversationPort } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';

const F1 = ferretId('f1');

async function boot() {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: F1, state: 'working' });
  return await testHost({
    plugins: [daemon],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-11-07T09:00:00Z'),
  });
}

describe('the port’s transcript tail with tool calls', () => {
  test('a ferret with no proved transcript is not_found, never answered with an empty tail', async () => {
    const host = await boot();
    const result = await host.provided(ConversationPort).transcriptEvents(F1, { limit: 50 });
    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await host.stop();
  });

  test('a ferret nobody knows is not_found', async () => {
    const host = await boot();
    const result = await host.provided(ConversationPort).transcriptEvents(ferretId('ghost'));
    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await host.stop();
  });
});

describe('the port’s log tail of every event kind (transcriptLog, additive)', () => {
  test('a ferret with no proved transcript is not_found, never answered with an empty log', async () => {
    const host = await boot();
    const read = host.provided(ConversationPort).transcriptLog;
    if (read === undefined) throw new Error('Conversation provides transcriptLog');
    expect(await read(F1, { limit: 20 })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await host.stop();
  });

  test('a ferret nobody knows is not_found', async () => {
    const host = await boot();
    const read = host.provided(ConversationPort).transcriptLog;
    if (read === undefined) throw new Error('Conversation provides transcriptLog');
    expect(await read(ferretId('ghost'))).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await host.stop();
  });
});

describe('the port’s messages, log page and log search (G162, served by the same reader as the routes)', () => {
  test('a ferret with no proved transcript is not_found on each, never an empty answer or the old pending sentence', async () => {
    const host = await boot();
    const port = host.provided(ConversationPort);
    expect(await port.transcript(F1, { limit: 5 })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await port.logPage(F1, { limit: 5 })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await port.logSearch(F1, 'deploy')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await host.stop();
  });

  test('a ferret nobody knows is not_found on each', async () => {
    const host = await boot();
    const port = host.provided(ConversationPort);
    const ghost = ferretId('ghost');
    expect(await port.transcript(ghost)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await port.logPage(ghost)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await port.logSearch(ghost, 'x')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await host.stop();
  });
});
