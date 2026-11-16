import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { ApiRequest } from '@ferretry/kernel/contract';
import { parseBody, parseOptionalBody } from '../../daemon/lib/body.ts';

const Schema = z.strictObject({ name: z.string(), nested: z.strictObject({ count: z.number() }).optional() });

/** A request whose bounded read answers `text`, or throws what the kernel would. */
function request(read: string | Error, seen: number[] = []): ApiRequest {
  return {
    text: async (limit: number) => {
      seen.push(limit);
      if (read instanceof Error) throw read;
      return read;
    },
  } as unknown as ApiRequest;
}

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { status: number; code: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe('parseBody', () => {
  test('returns the parsed value of a body that satisfies the schema, read under the default bound', async () => {
    const seen: number[] = [];
    expect(await parseBody(request('{"name":"acme"}', seen), Schema)).toEqual({ name: 'acme' });
    expect(seen[0]).toBeGreaterThan(32 * 1024 * 1024);
  });
  test('reads under the route’s own bound when it gives one', async () => {
    const seen: number[] = [];
    await parseBody(request('{"name":"acme"}', seen), Schema, { maxBytes: 1024 });
    expect(seen).toEqual([1024]);
  });
  test('a body that is not JSON is a 400 invalid_json that does not echo the body', async () => {
    const error = await refusal(parseBody(request('{oops secret-value'), Schema));
    expect([error.status, error.code]).toEqual([400, 'invalid_json']);
    expect(error.message).not.toContain('secret-value');
  });
  test('a body that breaks the schema names the failing paths and never the submitted values', async () => {
    const error = await refusal(parseBody(request('{"name":7,"nested":{"count":"hunter2"}}'), Schema));
    expect([error.status, error.code]).toEqual([400, 'invalid_request']);
    expect(error.message).toContain('name:');
    expect(error.message).toContain('nested.count:');
    expect(error.message).not.toContain('hunter2');
  });
  test('a body that is not an object at all is named as the body itself', async () => {
    const error = await refusal(parseBody(request('[]'), Schema));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('the request body is invalid — body:');
  });
  test('an over-limit read is a 413 body_too_large carrying only the kernel’s own sentence', async () => {
    const tooLarge = Object.assign(new Error('the request body is larger than 10 bytes'), {
      name: 'BodyTooLargeError',
    });
    const error = await refusal(parseBody(request(tooLarge), Schema));
    expect([error.status, error.code, error.message]).toEqual([
      413,
      'body_too_large',
      'the request body is larger than 10 bytes',
    ]);
  });
  test('any other read failure is a 400 unreadable_body that does not repeat the cause', async () => {
    const error = await refusal(parseBody(request(new Error('socket reset: secret-value')), Schema));
    expect([error.status, error.code, error.message]).toEqual([
      400,
      'unreadable_body',
      'the request body could not be read',
    ]);
    const odd = await refusal(parseBody({ text: async () => Promise.reject('not an error') } as ApiRequest, Schema));
    expect(odd.code).toBe('unreadable_body');
  });
});

describe('parseOptionalBody', () => {
  const Optional = z.strictObject({ note: z.string().optional() });

  test('an empty or whitespace-only body is the no-fields case', async () => {
    expect(await parseOptionalBody(request(''), Optional)).toEqual({});
    expect(await parseOptionalBody(request('  \n\t'), Optional)).toEqual({});
  });
  test('a body that is present is parsed like any other', async () => {
    expect(await parseOptionalBody(request('{"note":"hi"}'), Optional)).toEqual({ note: 'hi' });
  });
  test('malformed JSON is still refused rather than downgraded to no fields', async () => {
    const error = await refusal(parseOptionalBody(request('{oops'), Optional));
    expect([error.status, error.code]).toEqual([400, 'invalid_json']);
  });
  test('the no-fields case still has to satisfy the schema', async () => {
    const error = await refusal(parseOptionalBody(request(''), Schema));
    expect([error.status, error.code]).toEqual([400, 'invalid_request']);
    expect(error.message).toContain('name:');
  });
  test('an oversized body is refused even where the body is optional', async () => {
    const tooLarge = Object.assign(new Error('too big'), { name: 'BodyTooLargeError' });
    const error = await refusal(parseOptionalBody(request(tooLarge), Optional, { maxBytes: 8 }));
    expect([error.status, error.code]).toEqual([413, 'body_too_large']);
  });
});
