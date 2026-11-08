import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { ApiRequest } from '@ferretry/kernel/contract';
import { parseBody } from '../../daemon/lib/body.ts';

const Schema = z.strictObject({ rule: z.string(), nested: z.strictObject({ count: z.number() }).optional() });

/** A request whose bounded read answers `text`, or throws what the kernel would. */
function request(read: string | Error | unknown, seen: number[] = []): ApiRequest {
  return {
    text: async (limit: number) => {
      seen.push(limit);
      if (typeof read !== 'string') throw read;
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
  test('returns the parsed value of a body that satisfies the schema, read under the lesson bound', async () => {
    const seen: number[] = [];
    expect(await parseBody(request('{"rule":"Use bun"}', seen), Schema)).toEqual({ rule: 'Use bun' });
    expect(seen).toEqual([64 * 1024]);
  });
  test('a body that is not JSON is a 400 invalid_json that does not echo the body', async () => {
    const error = await refusal(parseBody(request('{oops secret-value'), Schema));
    expect([error.status, error.code]).toEqual([400, 'invalid_json']);
    expect(error.message).not.toContain('secret-value');
  });
  test('a body that breaks the schema names the failing paths and never the submitted values', async () => {
    const error = await refusal(parseBody(request('{"rule":7,"nested":{"count":"hunter2"}}'), Schema));
    expect([error.status, error.code]).toEqual([400, 'invalid_request']);
    expect(error.message).toContain('rule:');
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
  });
});
