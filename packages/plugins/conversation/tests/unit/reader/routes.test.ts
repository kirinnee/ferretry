import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { FerretId, TranscriptEntry } from '@ferretry/core-ferrets/contract';
import type { ApiRequest } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { registerReader } from '../../../daemon/reader/index.ts';

const at = (n: number): Instant => `2026-02-01T09:00:0${n}.000Z` as Instant;

const entries = (secret = 'hunter2'): TranscriptEntry[] => [
  { id: 'e1', at: at(1), role: 'user', text: 'please fix the build' },
  { id: 'e2', at: at(2), role: 'assistant', text: `done, the key was ${secret}` },
  { id: 'e3', at: at(3), role: 'assistant', text: 'anything else?' },
];

const harnessOf = (current: () => TranscriptEntry[]) => ({
  harness: 'claude' as const,
  reader: {
    read: async (_ferret: FerretId, after?: string, limit = 1000) => {
      const all = current();
      const start = after === undefined ? 0 : all.findIndex(entry => entry.id === after) + 1;
      return all.slice(start, start + limit);
    },
    follow: () => (async function* () {})(),
    find: async () => undefined,
  },
});

const reader = (current: () => TranscriptEntry[], known = true) =>
  registerReader({
    transcripts: async () => (known ? harnessOf(current) : undefined),
    exists: async ferret => known && ferret === 'lead',
    codec: {
      tag: async input => new Uint8Array(createHmac('sha256', 'k').update(input).digest()),
      matches: async (input, tag) =>
        Buffer.from(createHmac('sha256', 'k').update(input).digest()).equals(Buffer.from(tag)),
    },
    redactor: {
      redact: async text => text.replaceAll('hunter2', '[redacted]'),
      batch: async work =>
        work({ text: text => text.replaceAll('hunter2', '[redacted]'), data: value => value }),
    },
    history: {} as never,
    locate: { locate: async () => undefined },
    now: () => 0,
  });

const call = (query: Record<string, string> = {}, headers: Record<string, string> = {}, params: Record<string, string> = {}) =>
  ({
    request: {
      query: new Map(Object.entries(query).map(([key, value]) => [key, [value]])),
      headers: { get: (name: string) => headers[name] },
      text: async () => '',
    } as unknown as ApiRequest,
    params: new Map(Object.entries({ ferretId: 'lead', ...params })),
  }) as never;

const refusal = async (promise: Promise<unknown>) =>
  await promise.then(
    () => undefined,
    (error: unknown) => error as { status: number; code?: string },
  );

describe('the transcript routes', () => {
  const routes = reader(() => entries()).routes;

  test('R265 logs are scrubbed and carry a strong etag over the text served', async () => {
    const first = await routes['GET /v1/ferrets/:ferretId/logs'](call());
    expect(first.body).toContain('[redacted]');
    expect(first.body).not.toContain('hunter2');
    const etag = first.headers.get('etag') as string;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/u);
    const again = await routes['GET /v1/ferrets/:ferretId/logs'](call({}, { 'if-none-match': etag }));
    expect(again.status).toBe(304);
    expect(again.body).toBe('');
  });

  test('R265 a changed conversation changes the etag', async () => {
    let live = entries();
    const moving = reader(() => live).routes;
    const first = await moving['GET /v1/ferrets/:ferretId/logs'](call());
    live = [...live, { id: 'e4', at: at(4), role: 'user', text: 'thanks' }];
    const second = await moving['GET /v1/ferrets/:ferretId/logs'](
      call({}, { 'if-none-match': first.headers.get('etag') as string }),
    );
    expect(second.status).toBe(200);
  });

  test('R266 a page of another file than the earlier pages came from is a 409 log_cursor_stale', async () => {
    const page = JSON.parse((await routes['GET /v1/ferrets/:ferretId/log-page'](call({ limit: '2' }))).body) as {
      file: string;
      start: number;
    };
    const next = await routes['GET /v1/ferrets/:ferretId/log-page'](
      call({ before: String(page.start), file: page.file }),
    );
    expect(next.status).toBe(200);
    const stale = await refusal(
      Promise.resolve(routes['GET /v1/ferrets/:ferretId/log-page'](call({ before: String(page.start), file: 'other' }))),
    );
    expect(stale).toMatchObject({ status: 409, code: 'log_cursor_stale' });
  });

  test('G41 messages are bounded rows with a binding, and a cursor walks to the end without a row twice', async () => {
    const first = JSON.parse(
      (await routes['GET /v1/ferrets/:ferretId/messages'](call({ limit: '2' }))).body,
    ) as { messages: { text: string; selectionBinding: string; point: string }[]; nextCursor: string | null };
    expect(first.messages.map(row => row.text)).toEqual(['please fix the build', 'done, the key was [redacted]']);
    expect(first.messages.every(row => row.selectionBinding !== '')).toBe(true);
    const second = JSON.parse(
      (await routes['GET /v1/ferrets/:ferretId/messages'](call({ cursor: first.nextCursor as string }))).body,
    ) as { messages: { text: string }[] };
    expect(second.messages.map(row => row.text)).toEqual(['anything else?']);
  });

  test('G41 a cursor stays valid across an append and refuses once an earlier entry changed', async () => {
    let live = entries();
    const moving = reader(() => live).routes;
    const first = JSON.parse(
      (await moving['GET /v1/ferrets/:ferretId/messages'](call({ limit: '2' }))).body,
    ) as { nextCursor: string };
    live = [...live, { id: 'e4', at: at(4), role: 'user', text: 'thanks' }];
    const grown = await moving['GET /v1/ferrets/:ferretId/messages'](call({ cursor: first.nextCursor }));
    expect(grown.status).toBe(200);
    live = entries('changed');
    const changed = await refusal(
      Promise.resolve(moving['GET /v1/ferrets/:ferretId/messages'](call({ cursor: first.nextCursor }))),
    );
    expect(changed).toMatchObject({ status: 409, code: 'message_cursor_stale' });
  });

  test('G164 a search snippet is cut from the masked text', async () => {
    const found = JSON.parse(
      (await routes['GET /v1/ferrets/:ferretId/log-search'](call({ q: 'key was' }))).body,
    ) as { matches: { snippet: string }[] };
    expect(found.matches).toHaveLength(1);
    expect(JSON.stringify(found)).not.toContain('hunter2');
  });

  test('an unknown ferret is a 404, not an empty page', async () => {
    const absent = await refusal(
      Promise.resolve(routes['GET /v1/ferrets/:ferretId/logs'](call({}, {}, { ferretId: 'nobody' }))),
    );
    expect(absent).toMatchObject({ status: 404, code: 'not-found' });
  });

  test('G162 a malformed image handle is a 400 invalid_image_handle', async () => {
    const bad = await refusal(
      Promise.resolve(routes['GET /v1/ferrets/:ferretId/transcript-images/:handle'](call({}, {}, { handle: 'nope' }))),
    );
    expect(bad).toMatchObject({ status: 400, code: 'invalid_image_handle' });
  });
});
