import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  BodyTooLargeError,
  MAX_REQUEST_BODY_BYTES,
  MAX_TEXT_BODY_BYTES,
  parseBody,
  parseOptionalBody,
  parseQuery,
} from '../../../contract/body.ts';
import { secretsMatch } from '../../../contract/compare.ts';
import { ApiError, type ApiRequest, queryFrom } from '../../../contract/http.ts';

const SendSchema = z.object({ text: z.string().min(1), urgent: z.boolean().default(false) }).strict();
const PageSchema = z.object({ limit: z.coerce.number().int().positive().max(100).default(20) });

/** A request whose `text(limit)` behaves like the listener's and a session's: over the limit throws today's 413. */
function request(body: string, reads: number[] = [], broken = false): ApiRequest {
  return {
    method: 'POST',
    path: '/v1/x',
    query: queryFrom([]),
    headers: new Map(),
    arrival: { kind: 'carried', carrier: 'relay' },
    text: async limit => {
      reads.push(limit ?? -1);
      if (broken) throw new Error('socket reset');
      if (limit !== undefined && new TextEncoder().encode(body).byteLength > limit) throw new BodyTooLargeError(limit);
      return body;
    },
  } as ApiRequest;
}

async function rejection(act: () => Promise<unknown>): Promise<ApiError> {
  try {
    await act();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('parseBody (today’s api/body.ts)', () => {
  test('returns the parsed value with defaults applied, reading at most the shipped ceiling', async () => {
    const reads: number[] = [];
    expect(await parseBody(request(JSON.stringify({ text: 'hello' }), reads), SendSchema)).toEqual({ text: 'hello', urgent: false });
    expect(reads).toEqual([MAX_REQUEST_BODY_BYTES]);
  });

  test('not JSON is 400 invalid_json; a schema miss is 400 invalid_request naming the field, never the value', async () => {
    const notJson = await rejection(() => parseBody(request('not json'), SendSchema));
    expect([notJson.status, notJson.code, notJson.message]).toEqual([400, 'invalid_json', 'the request body is not valid JSON']);
    const wrong = await rejection(() => parseBody(request(JSON.stringify({ text: 'hunter2-secret', extra: 1 })), SendSchema));
    expect([wrong.status, wrong.code]).toEqual([400, 'invalid_request']);
    expect(wrong.message.startsWith('the request body is invalid — ')).toBe(true);
    expect(wrong.message.includes('hunter2-secret')).toBe(false);
    expect(wrong.validationIssues?.length).toBeGreaterThan(0);
  });

  test('a body the transport could not read is 400 unreadable_body', async () => {
    const error = await rejection(() => parseBody(request('{}', [], true), SendSchema));
    expect([error.status, error.code, error.message]).toEqual([400, 'unreadable_body', 'the request body could not be read']);
  });

  test('a body of exactly the bound is read; one byte over is 413 body_too_large naming only the number', async () => {
    const exact = JSON.stringify({ text: 'x'.repeat(10) });
    expect(await parseBody(request(exact), SendSchema, { maxBytes: exact.length })).toEqual({ text: 'x'.repeat(10), urgent: false });
    const over = await rejection(() => parseBody(request(exact), SendSchema, { maxBytes: exact.length - 1 }));
    expect([over.status, over.code, over.message]).toEqual([
      413,
      'body_too_large',
      `the request body is over the ${exact.length - 1}-byte limit`,
    ]);
  });

  test('the text bound is 512 KiB and the request ceiling fits one base64 32 MiB attachment plus its envelope', () => {
    expect(MAX_TEXT_BODY_BYTES).toBe(512 * 1024);
    expect(MAX_REQUEST_BODY_BYTES).toBe(Math.ceil((32 * 1024 * 1024) / 3) * 4 + 4 * 1024 * 1024);
  });
});

describe('parseOptionalBody', () => {
  test('an absent or whitespace body is no fields; malformed JSON is still refused; still bounded', async () => {
    const Schema = z.object({ note: z.string().optional() }).strict();
    expect(await parseOptionalBody(request(''), Schema)).toEqual({});
    expect(await parseOptionalBody(request('  \n'), Schema)).toEqual({});
    expect(await parseOptionalBody(request('{"note":"a"}'), Schema)).toEqual({ note: 'a' });
    expect((await rejection(() => parseOptionalBody(request('{'), Schema))).code).toBe('invalid_json');
    expect((await rejection(() => parseOptionalBody(request('x'.repeat(20)), Schema, { maxBytes: 4 }))).status).toBe(413);
  });
});

describe('parseQuery', () => {
  test('takes the first value of each key, coerces, applies defaults and names the surface', () => {
    const base = request('');
    expect(parseQuery({ ...base, query: queryFrom([['limit', '5'], ['limit', '9']]) }, PageSchema)).toEqual({ limit: 5 });
    expect(parseQuery(base, PageSchema)).toEqual({ limit: 20 });
    expect(() => parseQuery({ ...base, query: queryFrom([['limit', '500']]) }, PageSchema)).toThrow(/the request query is invalid — limit:/);
  });
});

describe('secretsMatch (today’s constant-time compare)', () => {
  const cases: readonly (readonly [string, string, boolean])[] = [
    ['abc', 'abc', true],
    ['abc', 'abd', false],
    ['abc', 'abcd', false],
    ['abcd', 'abc', false],
    ['', '', true],
    ['', 'a', false],
  ];
  for (const [left, right, expected] of cases)
    test(`answers ${String(expected)} comparing "${left}" with "${right}"`, () => {
      expect(secretsMatch(left, right)).toBe(expected);
    });
  test('a prefix match and a first-character mismatch are both unequal', () => {
    expect(secretsMatch('aaaaaaaa', 'aaaaaaab')).toBe(false);
    expect(secretsMatch('baaaaaaa', 'aaaaaaaa')).toBe(false);
  });
});
