import { describe, expect, it } from 'bun:test';
import type { ApiRequest } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { namesTag, parseBody } from '../../../daemon/reader/lib/http.ts';

const Schema = z.strictObject({ name: z.string(), nested: z.strictObject({ count: z.number() }).optional() });

const request = (read: string | Error, seen: number[] = []): ApiRequest =>
  ({
    text: async (limit: number) => {
      seen.push(limit);
      if (read instanceof Error) throw read;
      return read;
    },
  }) as unknown as ApiRequest;

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { status: number; code: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe('parseBody', () => {
  it('returns the value of a body that satisfies the schema, read under the bound it was given', async () => {
    const seen: number[] = [];
    expect(await parseBody(request('{"name":"acme"}', seen), Schema, 1024)).toEqual({ name: 'acme' });
    expect(seen).toEqual([1024]);
    await parseBody(request('{"name":"acme"}', seen), Schema);
    expect(seen[1]).toBeGreaterThan(32 * 1024 * 1024);
  });

  it('answers 400 unreadable_body when the body cannot be read', async () => {
    const error = await refusal(parseBody(request(new Error('too big')), Schema));
    expect(error.status).toBe(400);
    expect(error.code).toBe('unreadable_body');
  });

  it('answers 400 invalid_json without echoing the text', async () => {
    const error = await refusal(parseBody(request('{oops secret-value'), Schema));
    expect(error.code).toBe('invalid_json');
    expect(error.message).not.toContain('secret-value');
  });

  it('names the failing paths of an invalid body and not the values', async () => {
    const error = await refusal(parseBody(request('{"name":7,"nested":{"count":"secret"}}'), Schema));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('name:');
    expect(error.message).toContain('nested.count:');
    expect(error.message).not.toContain('secret');
    expect((await refusal(parseBody(request('[]'), Schema))).message).toContain('body:');
  });
});

describe('namesTag', () => {
  it('matches the tag, weakly, among several and for *', () => {
    expect(namesTag('"a"', '"a"')).toBe(true);
    expect(namesTag('W/"a"', '"a"')).toBe(true);
    expect(namesTag('"b", W/"a"', '"a"')).toBe(true);
    expect(namesTag('*', '"a"')).toBe(true);
    expect(namesTag('"b"', '"a"')).toBe(false);
  });
});
