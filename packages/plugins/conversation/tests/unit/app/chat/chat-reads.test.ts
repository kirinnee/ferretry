import { describe, expect, test } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { chatReadApi, readLogPage, VALIDATED_LOG_LIMIT, ValidatedLogMemory } from '../../../../app/chat/chat-reads.ts';
import { fakeClient } from '../../../support/app/fake-client.ts';

/**
 * R265 — the transcript tail is read conditionally. A quiet ferret answers the same redacted text on every poll, so
 * the last page each read path answered is held with its etag and the next read of that path takes a bodyless 304.
 * These cases drive the client's validator memory through a fake `client.conditional`.
 */

const LOG_PAGE = 'GET /v1/ferrets/:ferretId/log-page';

const page = (ferret: string, log: string) => ({ v: 1, ferret, log, start: 0, file: 'f1' });

type Conditional = NonNullable<PluginClient['conditional']>;

/** A daemon that answers each ferret's tail with its current text and an etag over that text. */
const daemon = () => {
  const texts = new Map<string, string>();
  const asked: Array<{ readonly ferretId: string; readonly ifNoneMatch?: string }> = [];
  let answerNoValidator = false;
  const etagOf = (ferretId: string) => `"${ferretId}:${texts.get(ferretId) ?? ''}"`;
  const conditional: Conditional = async (_key, params, init) => {
    const ferretId = params['ferretId'] ?? '';
    const ifNoneMatch = init?.ifNoneMatch;
    asked.push({ ferretId, ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }) });
    const etag = etagOf(ferretId);
    if (ifNoneMatch === etag) return { status: 304, etag };
    const body = page(ferretId, texts.get(ferretId) ?? '');
    return answerNoValidator ? { status: 200, body } : { status: 200, etag, body };
  };
  const client = fakeClient(
    {
      [LOG_PAGE]: init => page(init.params?.['ferretId'] ?? '', `whole:${init.query?.['before'] ?? ''}`),
    },
    conditional,
  );
  return {
    client,
    asked,
    write: (ferretId: string, text: string) => void texts.set(ferretId, text),
    withoutValidators: () => {
      answerNoValidator = true;
    },
  };
};

describe('R265 the transcript validator memory', () => {
  test('R265 a second read of an unchanged tail sends the etag it held and answers the held page from a 304', async () => {
    const world = daemon();
    world.write('a', 'assistant/message: hello');
    const memory = new ValidatedLogMemory();

    const first = await readLogPage(world.client, 'a', {}, memory);
    const second = await readLogPage(world.client, 'a', {}, memory);

    expect(second).toEqual(first);
    expect(world.asked).toEqual([{ ferretId: 'a' }, { ferretId: 'a', ifNoneMatch: '"a:assistant/message: hello"' }]);
  });

  test('R265 a changed tail (a new message, or a mask change over the same words) is read whole, never served from memory', async () => {
    const world = daemon();
    world.write('a', 'user/message: my key is [masked]');
    const memory = new ValidatedLogMemory();
    await readLogPage(world.client, 'a', {}, memory);

    // The daemon's redacted text moved, so its strong etag did: the held body stands for nothing now.
    world.write('a', 'user/message: my key is [masked:2]');
    const next = await readLogPage(world.client, 'a', {}, memory);

    expect(next.log).toBe('user/message: my key is [masked:2]');
    expect(memory.recall(`${LOG_PAGE} a`)?.page.log).toBe('user/message: my key is [masked:2]');
  });

  test(`R265 holds at most ${VALIDATED_LOG_LIMIT} read paths, least recently used first out`, async () => {
    const world = daemon();
    const memory = new ValidatedLogMemory();
    for (let index = 0; index <= VALIDATED_LOG_LIMIT; index += 1) {
      world.write(`f${index}`, `m${index}`);
      await readLogPage(world.client, `f${index}`, {}, memory);
    }

    expect(memory.paths()).toHaveLength(VALIDATED_LOG_LIMIT);
    expect(memory.paths()).not.toContain(`${LOG_PAGE} f0`);
    expect(memory.paths().at(-1)).toBe(`${LOG_PAGE} f${VALIDATED_LOG_LIMIT}`);

    // A 304 refreshes its path's place, so the next eviction takes the oldest untouched one instead.
    await readLogPage(world.client, 'f1', {}, memory);
    world.write('f99', 'm99');
    await readLogPage(world.client, 'f99', {}, memory);
    expect(memory.paths()).toContain(`${LOG_PAGE} f1`);
    expect(memory.paths()).not.toContain(`${LOG_PAGE} f2`);
  });

  test('R265 a 304 to a read that sent no validator is an error, not an empty transcript', async () => {
    const client = fakeClient({}, async () => ({ status: 304 }));
    await expect(readLogPage(client, 'a', {}, new ValidatedLogMemory())).rejects.toThrow('sent no validator');
  });

  test('R265 an answer with no etag forgets the path, so the next read asks without one', async () => {
    const world = daemon();
    world.write('a', 'one');
    const memory = new ValidatedLogMemory();
    await readLogPage(world.client, 'a', {}, memory);
    world.withoutValidators();
    world.write('a', 'two');
    await readLogPage(world.client, 'a', {}, memory);
    await readLogPage(world.client, 'a', {}, memory);

    expect(memory.paths()).toEqual([]);
    expect(world.asked.at(-1)).toEqual({ ferretId: 'a' });
  });

  test('R265 a page with a query (an older page) is read whole through the plain route', async () => {
    const world = daemon();
    const older = await readLogPage(world.client, 'a', { before: 400, file: 'f1' }, new ValidatedLogMemory());

    expect(older.log).toBe('whole:400');
    expect(world.asked).toEqual([]);
    expect(world.client.calls).toEqual([
      { route: LOG_PAGE, init: { params: { ferretId: 'a' }, query: { before: '400', file: 'f1' } } },
    ]);
  });

  test('R265 a client with no conditional read reads every tail whole', async () => {
    const client = fakeClient({ [LOG_PAGE]: init => page(init.params?.['ferretId'] ?? '', 'plain') });
    expect((await readLogPage(client, 'a')).log).toBe('plain');
    expect((await readLogPage(client, 'a')).log).toBe('plain');
    expect(client.calls).toHaveLength(2);
  });

  test('R265 the memory is per client, so one daemon never answers from another daemon’s pages', async () => {
    const one = daemon();
    const two = daemon();
    one.write('a', 'on one');
    two.write('a', 'on two');

    await chatReadApi(one.client).logPage('a');
    const answer = await chatReadApi(two.client).logPage('a');

    expect(answer.log).toBe('on two');
    expect(two.asked).toEqual([{ ferretId: 'a' }]);
  });
});
