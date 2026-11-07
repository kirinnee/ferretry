import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { FerretId, TranscriptEntry } from '@ferretry/core-ferrets/contract';
import type { ApiRequest, Redaction, RedactionScope } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { LogPageSchema } from '../../../contract/index.ts';
import { registerReader } from '../../../daemon/reader/index.ts';
import type { TranscriptReadRedactor } from '../../../daemon/reader/lib/reads.ts';
import manifest from '../../../manifest.ts';

/**
 * G163: the log page (`GET /v1/ferrets/:ferretId/log-page`) is scrubbed like `/logs`; `start` is a bounded byte
 * offset and `file` an opaque digest, never a path.
 *
 * Every case drives the REAL handler (`registerReader(...).routes[...]`). The only stand-in is the Vault: a
 * `Redaction` that opens a fixed set of seeded values for one read and masks them as Vault does
 * (`[redacted:NAME]`), plus a token-shaped rule, wrapped by the same adapter `daemon/reading.ts` puts between
 * the kernel's `Redaction` and the reader (`readRedactor`).
 */

const ROUTE = 'GET /v1/ferrets/:ferretId/log-page' as const;
const LOGS = 'GET /v1/ferrets/:ferretId/logs' as const;
const SEEDED = 'hunter2-seeded-vault-value';
const TOKEN_SHAPED = 'sk-live-0123456789abcdef';
const PATH_LIKE_ID = '/home/kirin/.claude/projects/-work/session-7.jsonl';

const at = (n: number): Instant => `2026-02-01T09:00:0${n}.000Z` as Instant;

/** The Vault stand-in: values opened for one read, masked the way Vault masks (`secretMask`), plus the token shape. */
class StandInRedaction implements Redaction {
  opens = 0;
  constructor(
    private readonly values: ReadonlyMap<string, string>,
    private readonly damaged = false,
  ) {}

  async read<T>(fn: (scope: RedactionScope) => T | Promise<T>): Promise<T> {
    if (this.damaged) throw new Error('the vault could not be opened');
    this.opens += 1;
    const text = (input: string): string => {
      const seeded = [...this.values].reduce(
        (out, [name, value]) => out.split(value).join(`[redacted:${name}]`),
        input,
      );
      return seeded.replace(/\bsk-[A-Za-z0-9-]{10,}/gu, '[redacted:TOKEN]');
    };
    return await fn({
      text,
      lines: lines => lines.map(text),
      cells: grid => ({ columns: grid.columns, rows: grid.rows.map(row => text(row.join('')).split('')) }),
    });
  }
}

/** `daemon/reading.ts` `readRedactor`, over the kernel's `Redaction`. */
const readRedactor = (redaction: Redaction): TranscriptReadRedactor => ({
  redact: async text => await redaction.read(scope => scope.text(text)),
  batch: async work =>
    await redaction.read(scope =>
      work({
        text: text => scope.text(text),
        data: value => JSON.parse(scope.text(JSON.stringify(value))) as unknown,
      }),
    ),
});

const entriesOf = (secret: string, firstId = 'e1'): TranscriptEntry[] => [
  { id: firstId, at: at(1), role: 'user', text: 'please fix the build' },
  { id: 'e2', at: at(2), role: 'assistant', text: `done, the key was ${secret}` },
  { id: 'e3', at: at(3), role: 'assistant', text: `and the token ${TOKEN_SHAPED} is rotated` },
  { id: 'e4', at: at(4), role: 'assistant', text: 'anything else?' },
];

const readerOver = (
  current: () => TranscriptEntry[],
  redaction: Redaction = new StandInRedaction(new Map([['DEPLOY_KEY', SEEDED]])),
  known: readonly string[] = ['lead'],
) =>
  registerReader({
    transcripts: async () => ({
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
    }),
    exists: async ferret => known.includes(ferret),
    codec: {
      tag: async input => new Uint8Array(createHmac('sha256', 'k').update(input).digest()),
      matches: async (input, tag) =>
        Buffer.from(createHmac('sha256', 'k').update(input).digest()).equals(Buffer.from(tag)),
    },
    redactor: readRedactor(redaction),
    history: {} as never,
    locate: { locate: async () => undefined },
    now: () => 0,
  });

const call = (
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
  params: Record<string, string> = {},
) =>
  ({
    request: {
      query: new Map(Object.entries(query).map(([key, value]) => [key, [value]])),
      headers: { get: (name: string) => headers[name] },
      text: async () => '',
    } as unknown as ApiRequest,
    params: new Map(Object.entries({ ferretId: 'lead', ...params })),
  }) as never;

type Refusal = { status: number; code?: string; message?: string };
const refusal = async (promise: Promise<unknown>): Promise<Refusal | undefined> =>
  await promise.then(
    () => undefined,
    (error: unknown) => error as Refusal,
  );

type Routes = ReturnType<typeof readerOver>['routes'];
const page = async (routes: Routes, query: Record<string, string> = {}, params: Record<string, string> = {}) =>
  LogPageSchema.parse(JSON.parse((await routes[ROUTE](call(query, {}, params))).body));

describe('G163 every line the log page serves is scrubbed by the Vault output guard', () => {
  test('G163 a seeded vault value and a token-shaped string never appear, on the tail or on any older page', async () => {
    const { routes } = readerOver(() => entriesOf(SEEDED));
    const tail = await routes[ROUTE](call());
    expect(tail.body).toContain('[redacted:DEPLOY_KEY]');
    expect(tail.body).toContain('[redacted:TOKEN]');
    expect(tail.body).not.toContain(SEEDED);
    expect(tail.body).not.toContain(TOKEN_SHAPED);
    // Walk back one record at a time: no page, however small, carries either value.
    let before: number | undefined;
    const seen: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      const one = await page(routes, before === undefined ? { limit: '1' } : { limit: '1', before: String(before) });
      seen.push(JSON.stringify(one));
      if (one.log === '') break;
      before = one.start;
    }
    expect(seen.length).toBeGreaterThan(3);
    for (const body of seen) {
      expect(body).not.toContain(SEEDED);
      expect(body).not.toContain(TOKEN_SHAPED);
    }
  });

  test('G163 the page is scrubbed exactly like /logs: the same text for the same records', async () => {
    const { routes } = readerOver(() => entriesOf(SEEDED));
    const logs = (await routes[LOGS](call())).body;
    const served = await page(routes);
    expect(served.log).toBe(logs);
  });

  test('G163 the strong etag is cut over the scrubbed body, so a validator cannot tell two secrets apart', async () => {
    // Two secrets of the same width: the raw files differ, the scrubbed text does not.
    const other = 'Z'.repeat(SEEDED.length);
    const world = (secret: string) =>
      readerOver(() => entriesOf(secret), new StandInRedaction(new Map([['DEPLOY_KEY', secret]]))).routes;
    const a = await world(SEEDED)[ROUTE](call());
    const b = await world(other)[ROUTE](call());
    expect(b.body).not.toContain(other);
    expect(b.headers.get('etag')).toBe(a.headers.get('etag'));
    const revalidated = await world(other)[ROUTE](call({}, { 'if-none-match': a.headers.get('etag') as string }));
    expect(revalidated.status).toBe(304);
    expect(revalidated.body).toBe('');
  });

  test('G163 a vault that cannot be opened refuses the page rather than serving raw text', async () => {
    const { routes } = readerOver(() => entriesOf(SEEDED), new StandInRedaction(new Map(), true));
    const refused = await refusal(Promise.resolve(routes[ROUTE](call())));
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused?.message)).not.toContain(SEEDED);
    expect(String(refused?.message)).not.toContain('please fix the build');
  });

  test('G163 the secrets are opened for that one read and the page asks for them once', async () => {
    const vault = new StandInRedaction(new Map([['DEPLOY_KEY', SEEDED]]));
    const { routes } = readerOver(() => entriesOf(SEEDED), vault);
    await routes[ROUTE](call());
    expect(vault.opens).toBe(1);
  });
});

describe('G163 start is a bounded byte offset', () => {
  const { routes } = readerOver(() => entriesOf(SEEDED));

  test('G163 the answer names where it begins as a non-negative integer byte offset, one per line', async () => {
    const served = await page(routes);
    expect(Number.isSafeInteger(served.start)).toBe(true);
    expect(served.start).toBeGreaterThanOrEqual(0);
    expect(served.offsets).toHaveLength(served.log.split('\n').length);
    expect(served.offsets?.[0]).toBe(served.start);
  });

  test('G163 the page before start meets it: every record exactly once, oldest page first', async () => {
    const newest = await page(routes, { limit: '2' });
    const older = await page(routes, { limit: '2', before: String(newest.start) });
    expect(older.start).toBeLessThan(newest.start);
    expect(Math.max(...(older.offsets ?? []))).toBeLessThan(newest.start);
    const together = `${older.log}\n${newest.log}`;
    expect(together).toBe((await page(routes, { limit: '4' })).log);
  });

  test.each([
    ['a negative before', { before: '-1' }],
    ['a fractional before', { before: '1.5' }],
    ['a before beyond the safe integers', { before: '1e300' }],
    ['a before that is not a number', { before: 'all' }],
    ['a before of Infinity', { before: 'Infinity' }],
    ['a negative from', { before: '10', from: '-1' }],
    ['a from with no before', { from: '0' }],
    ['a from past before', { before: '5', from: '9' }],
  ])('G163 %s is a 400 invalid_query', async (_name, query) => {
    const refused = await refusal(Promise.resolve(routes[ROUTE](call(query))));
    expect(refused).toMatchObject({ status: 400, code: 'invalid_query' });
  });

  test.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['fractional', '2.5'],
    ['past the ceiling', '2001'],
    ['unbounded', '9007199254740993'],
    ['not a number', 'all'],
  ])('G163 a limit that is %s is refused: a page is bounded', async (_name, limit) => {
    const refused = await refusal(Promise.resolve(routes[ROUTE](call({ limit }))));
    expect(refused).toMatchObject({ status: 400, code: 'invalid_query' });
  });

  test('G163 a page never holds more records than the ceiling and the largest allowed limit is served', async () => {
    const many = Array.from({ length: 2_100 }, (_, n) => ({
      id: `m${n}`,
      at: at(1),
      role: 'assistant' as const,
      text: `line ${n}`,
    }));
    const big = readerOver(() => many).routes;
    const served = await page(big, { limit: '2000' });
    expect(served.log.split('\n')).toHaveLength(2_000);
    const defaulted = await page(big);
    expect(defaulted.log.split('\n')).toHaveLength(200);
  });

  test('G163 a before that no record is older than answers an empty page, not an error', async () => {
    const empty = await page(routes, { before: '0' });
    expect(empty.log).toBe('');
    expect(empty.start).toBe(0);
  });
});

describe('G163 file is an opaque digest, never the path', () => {
  const DIGEST = /^[A-Za-z0-9_-]{22}$/u;

  test('G163 the digest is 22 characters of base64url, and the answer holds exactly the contract fields', async () => {
    const { routes } = readerOver(() => entriesOf(SEEDED));
    const body = JSON.parse((await routes[ROUTE](call())).body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['file', 'ferret', 'log', 'offsets', 'start', 'v'].sort());
    expect(body.file).toMatch(DIGEST);
  });

  test('G163 no answer carries a filesystem path, even when the transcript names one', async () => {
    const { routes } = readerOver(() => entriesOf(SEEDED, PATH_LIKE_ID));
    const served = await routes[ROUTE](call());
    const digest = (JSON.parse(served.body) as { file: string }).file;
    expect(digest).toMatch(DIGEST);
    expect(served.body).not.toContain(PATH_LIKE_ID);
    expect(served.body).not.toContain('/home/');
    expect(served.body).not.toContain('.jsonl');
    for (const header of served.headers.values()) expect(header).not.toContain('/home/');
  });

  test('G163 the digest changes with the conversation it names and with the ferret, so it is not a place', async () => {
    const lead = readerOver(() => entriesOf(SEEDED), undefined, ['lead', 'other']).routes;
    const first = await page(lead);
    const another = await page(readerOver(() => entriesOf(SEEDED, 'other-first'), undefined, ['lead', 'other']).routes);
    const second = await page(lead, {}, { ferretId: 'other' });
    expect(another.file).not.toBe(first.file);
    expect(second.file).not.toBe(first.file);
  });

  test('G163 the digest an earlier page carried is accepted for the pages that follow it', async () => {
    const { routes } = readerOver(() => entriesOf(SEEDED));
    const first = await page(routes, { limit: '2' });
    const next = await routes[ROUTE](call({ before: String(first.start), file: first.file }));
    expect(next.status).toBe(200);
  });

  test.each([
    ['an unknown token', 'other'],
    ['an absolute path', '/etc/passwd'],
    ['a relative traversal', '../../../etc/passwd'],
    ['an encoded traversal', '..%2F..%2Fetc%2Fpasswd'],
    ['a home path', PATH_LIKE_ID],
    ['a null byte', 'abc\u0000def'],
    ['a digest cut short', 'Zm9v'],
    ['a digest padded', `${'A'.repeat(22)}=`],
  ])(
    'G163 %s is refused as today: 409 log_cursor_stale, naming neither a path nor the real digest',
    async (_name, file) => {
      const { routes } = readerOver(() => entriesOf(SEEDED));
      const real = await page(routes);
      const refused = await refusal(Promise.resolve(routes[ROUTE](call({ file }))));
      expect(refused).toMatchObject({ status: 409, code: 'log_cursor_stale' });
      expect(String(refused?.message)).not.toContain(real.file);
      expect(String(refused?.message)).not.toContain('/etc');
      expect(String(refused?.message)).not.toContain('/home');
    },
  );

  test("G163 the digest of one ferret's transcript is stale for another's", async () => {
    const { routes } = readerOver(() => entriesOf(SEEDED), undefined, ['lead', 'other']);
    const mine = await page(routes);
    const refused = await refusal(Promise.resolve(routes[ROUTE](call({ file: mine.file }, {}, { ferretId: 'other' }))));
    expect(refused).toMatchObject({ status: 409, code: 'log_cursor_stale' });
  });

  test('G163 the digest of a conversation that was replaced is stale', async () => {
    let live = entriesOf(SEEDED);
    const { routes } = readerOver(() => live);
    const before = await page(routes);
    live = entriesOf(SEEDED, 'a-new-first-record');
    const refused = await refusal(Promise.resolve(routes[ROUTE](call({ file: before.file }))));
    expect(refused).toMatchObject({ status: 409, code: 'log_cursor_stale' });
  });

  test('G163 a blank file is no token at all, as today, and an unknown ferret is a 404 before anything is read', async () => {
    const { routes } = readerOver(() => entriesOf(SEEDED));
    expect((await routes[ROUTE](call({ file: '' }))).status).toBe(200);
    const unknown = await refusal(Promise.resolve(routes[ROUTE](call({ file: 'x' }, {}, { ferretId: 'ghost' }))));
    expect(unknown).toMatchObject({ status: 404, code: 'not-found' });
  });
});

describe('G163 who may read the log page is the descriptor of /logs', () => {
  const descriptor = (path: string) => manifest.actions.routes.find(route => route.key === `GET ${path}`);

  test('G163 log-page is declared with the minimum, caller, noStore and secrets guard of /logs and no capability', () => {
    const logs = descriptor('/v1/ferrets/:ferretId/logs');
    const logPage = descriptor('/v1/ferrets/:ferretId/log-page');
    expect(logPage).toBeDefined();
    expect(logPage).toMatchObject({ minimum: 'operator', caller: 'any', noStore: true, guard: 'secrets' });
    expect(logPage?.capability).toBeUndefined();
    for (const field of ['minimum', 'caller', 'noStore', 'guard', 'audit', 'capability'] as const)
      expect(logPage?.[field]).toEqual(logs?.[field]);
  });
});
