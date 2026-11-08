import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { ApiRequest } from '@ferretry/kernel/contract';
import { parseBody } from '../../../daemon/lib/body.ts';
import { serialExecutor } from '../../../daemon/lib/ports.ts';

describe('serialExecutor', () => {
  test('runs work one at a time, in the order it was asked for', async () => {
    const executor = serialExecutor();
    const order: string[] = [];
    const slow = executor.runExclusive(async () => {
      order.push('slow start');
      await new Promise(resolve => setTimeout(resolve, 20));
      order.push('slow end');
      return 'slow';
    });
    const fast = executor.runExclusive(async () => {
      order.push('fast');
      return 'fast';
    });
    expect(await Promise.all([slow, fast])).toEqual(['slow', 'fast']);
    expect(order).toEqual(['slow start', 'slow end', 'fast']);
  });

  test('work that throws rejects its own caller and never blocks the next', async () => {
    const executor = serialExecutor();
    const failed = executor.runExclusive(async () => {
      throw new Error('boom');
    });
    const next = executor.runExclusive(async () => 'still runs');
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('still runs');
  });
});

const Schema = z.strictObject({ rate: z.number(), nested: z.strictObject({ n: z.number() }).optional() });
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
  test('returns the parsed value, read under a 256 KiB bound', async () => {
    const seen: number[] = [];
    expect(await parseBody(request('{"rate":2}', seen), Schema)).toEqual({ rate: 2 });
    expect(seen).toEqual([256 * 1024]);
  });
  test('a body that cannot be read is a 400 unreadable_body', async () => {
    const error = await refusal(parseBody(request(new Error('reset: secret-value')), Schema));
    expect([error.status, error.code, error.message]).toEqual([
      400,
      'unreadable_body',
      'the request body could not be read',
    ]);
  });
  test('a body that is not JSON is a 400 invalid_json that does not echo it', async () => {
    const error = await refusal(parseBody(request('{oops secret-value'), Schema));
    expect([error.status, error.code]).toEqual([400, 'invalid_json']);
    expect(error.message).not.toContain('secret-value');
  });
  test('a body that breaks the schema names the failing paths, never the values', async () => {
    const error = await refusal(parseBody(request('{"rate":"hunter2","nested":{"n":"x"}}'), Schema));
    expect([error.status, error.code]).toEqual([400, 'invalid_request']);
    expect(error.message).toContain('rate:');
    expect(error.message).toContain('nested.n:');
    expect(error.message).not.toContain('hunter2');
    expect((await refusal(parseBody(request('[]'), Schema))).message).toContain('the request body is invalid: body:');
  });
});
