import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { CommandError } from '../../../cli/lib/errors.ts';
import { ClientConversationGateway, NO_FILE_ACCESS } from '../../../cli/lib/gateway.ts';

type Init = NonNullable<Parameters<PluginClient['call']>[1]>;

/** A client that answers each route key from `answers`, and records what it was asked. */
const build = (answers: Record<string, unknown | Error>) => {
  const calls: Array<{ route: string; init: Init | undefined }> = [];
  const client = {
    call: (async (route: string, init?: Init) => {
      calls.push({ route, init });
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return answer;
    }) as unknown as PluginClient['call'],
  };
  return { gateway: new ClientConversationGateway(client), calls };
};

const record = {
  v: 1,
  sendId: 's1',
  acceptedAt: '2026-11-07T12:00:00.000Z',
  acceptedTurn: 3,
  path: 'direct',
  message: 'hello',
  attachmentIds: [],
  fate: 'delivered',
};

describe('ClientConversationGateway', () => {
  it('sends through the send route and parses the result', async () => {
    const { gateway, calls } = build({
      'POST /v1/ferrets/:ferretId/send': { ferret: 'f1', disposition: 'queued', sendId: 's1' },
    });
    const result = await gateway.send('f1', { message: 'hello' } as never);
    expect([result.ferret, result.disposition, result.sendId]).toEqual(['f1', 'queued', 's1']);
    expect(calls[0]?.init).toEqual({ params: { ferretId: 'f1' }, body: { message: 'hello' } });
  });

  it('reads a send’s ledger row, and answers a 404 (a send the daemon does not know) as none rather than a failure', async () => {
    const missing = Object.assign(new Error('not found'), { status: 404 });
    const { gateway, calls } = build({ 'GET /v1/ferrets/:ferretId/sends/:sendId': record });
    expect((await gateway.sendStatus('f1', 's1'))?.sendId).toBe('s1');
    expect(calls[0]?.init).toEqual({ params: { ferretId: 'f1', sendId: 's1' } });

    const waiting = build({ 'GET /v1/ferrets/:ferretId/sends/:sendId': missing });
    expect(await waiting.gateway.sendStatus('f1', 's1')).toBeUndefined();

    const broken = build({
      'GET /v1/ferrets/:ferretId/sends/:sendId': Object.assign(new Error('boom'), { status: 500 }),
    });
    await expect(broken.gateway.sendStatus('f1', 's1')).rejects.toThrow('boom');
  });

  it('cannot upload: the shell gives a plugin no file access', async () => {
    const { gateway } = build({});
    await expect(gateway.upload('f1', 'a.png')).rejects.toBeInstanceOf(CommandError);
    await expect(gateway.upload('f1', 'a.png')).rejects.toThrow(NO_FILE_ACCESS);
  });

  it('parks a ferret on a reply through Ferrets’ signal route', async () => {
    const { gateway, calls } = build({ 'POST /v1/ferrets/:ferretId/signal': {} });
    await gateway.parkUntilReply('f1', { peer: 'f2', condition: 'their answer' });
    expect(calls[0]).toEqual({
      route: 'POST /v1/ferrets/:ferretId/signal',
      init: { params: { ferretId: 'f1' }, body: { kind: 'waiting', peer: 'f2', condition: 'their answer' } },
    });
  });

  it('reads the question a ferret asked, or none', async () => {
    const question = {
      format: 1,
      toolUseId: 't1',
      text: 'Which one?',
      options: [{ label: 'A' }],
      multiple: false,
      askedAt: '2026-11-07T12:00:00.000Z',
    };
    const asked = build({ 'GET /v1/ferrets/:ferretId/question': { question } });
    expect((await asked.gateway.question('f1'))?.text).toBe('Which one?');
    const none = build({ 'GET /v1/ferrets/:ferretId/question': { question: null } });
    expect(await none.gateway.question('f1')).toBeUndefined();
  });

  it('answers and interrupts through their routes', async () => {
    const { gateway, calls } = build({
      'POST /v1/ferrets/:ferretId/answer': {},
      'POST /v1/ferrets/:ferretId/interrupt': {},
    });
    await gateway.answer('f1', { answers: [] } as never);
    await gateway.interrupt('f1');
    expect(calls.map(call => call.init)).toEqual([
      { params: { ferretId: 'f1' }, body: { answers: [] } },
      { params: { ferretId: 'f1' }, body: {} },
    ]);
  });

  it('reads and writes the compaction threshold, parsing both answers', async () => {
    const { gateway, calls } = build({
      'GET /v1/ferrets/:ferretId/compact-at': { effective: 'auto', restartRequired: false, note: 'default' },
      'PATCH /v1/ferrets/:ferretId/compact-at': { effective: 200_000, restartRequired: true, note: 'on restart' },
    });
    expect((await gateway.read('f1')).effective).toBe('auto');
    const written = await gateway.write('f1', { compactAt: 200_000 } as never);
    expect(written).toEqual({ effective: 200_000, restartRequired: true, note: 'on restart' });
    expect(calls[1]?.init).toEqual({ params: { ferretId: 'f1' }, body: { compactAt: 200_000 } });
  });
});
