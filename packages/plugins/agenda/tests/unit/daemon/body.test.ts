import { describe, expect, it } from 'bun:test';
import type { ApiRequest } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { parseBody } from '../../../daemon/lib/body.ts';

const Schema = z.strictObject({ name: z.string(), nested: z.strictObject({ count: z.number() }).optional() });

const request = (read: string | Error): ApiRequest =>
  ({
    text: async () => {
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
  it('returns the value of a body that satisfies the schema', async () => {
    expect(await parseBody(request('{"name":"acme"}'), Schema)).toEqual({ name: 'acme' });
  });

  it('reads an empty body as {}', async () => {
    expect(await parseBody(request('  '), z.object({ a: z.string().optional() }))).toEqual({});
  });

  it('answers 400 unreadable_body when the body cannot be read', async () => {
    const error = await refusal(parseBody(request(new Error('socket reset')), Schema));
    expect(error.status).toBe(400);
    expect(error.code).toBe('unreadable_body');
  });

  it('answers 400 invalid_json for text that is not JSON, without echoing it', async () => {
    const error = await refusal(parseBody(request('{oops secret-value'), Schema));
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_json');
    expect(error.message).not.toContain('secret-value');
  });

  it('names the failing paths of an invalid body, and not the values', async () => {
    const error = await refusal(parseBody(request('{"name":7,"nested":{"count":"secret"}}'), Schema));
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('name:');
    expect(error.message).toContain('nested.count:');
    expect(error.message).not.toContain('secret');
    const bare = await refusal(parseBody(request('[]'), Schema));
    expect(bare.message).toContain('body:');
  });
});
