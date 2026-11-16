import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import { parseBody } from '../../../daemon/lib/body.ts';

const Schema = z.strictObject({ name: z.string() });

/** A request whose bounded read answers with `text`, or throws `failure`. */
function request(text: string | Error, seenMax?: { value?: number }): ApiRequest {
  return {
    async text(max?: number) {
      if (seenMax !== undefined) seenMax.value = max;
      if (text instanceof Error) throw text;
      return text;
    },
  } as unknown as ApiRequest;
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('parseBody', () => {
  it('returns the parsed body and reads at the caller-stated bound', async () => {
    const seen: { value?: number } = {};
    expect(await parseBody(request('{"name":"a"}', seen), Schema, { maxBytes: 64 })).toEqual({ name: 'a' });
    expect(seen.value).toBe(64);
  });

  it('reads at the daemon ceiling when the route states none', async () => {
    const seen: { value?: number } = {};
    await parseBody(request('{"name":"a"}', seen), Schema);
    expect(seen.value).toBeGreaterThan(32 * 1024 * 1024);
  });

  it('answers 413 with the daemon own sentence when the body is too large', async () => {
    const tooLarge = Object.assign(new Error('the request body is over 64 bytes'), { name: 'BodyTooLargeError' });
    const error = await refusal(parseBody(request(tooLarge), Schema));
    expect(error.status).toBe(413);
    expect(error.code).toBe('body_too_large');
    expect(error.message).toBe('the request body is over 64 bytes');
  });

  it('answers 400 when the body cannot be read at all', async () => {
    const error = await refusal(parseBody(request(new Error('socket reset')), Schema));
    expect(error.status).toBe(400);
    expect(error.code).toBe('unreadable_body');
    expect(error.message).not.toContain('socket');
  });

  it('answers 400 for text that is not JSON', async () => {
    const error = await refusal(parseBody(request('{nope'), Schema));
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_json');
  });

  it('names the failing path without echoing the submitted value', async () => {
    const error = await refusal(parseBody(request('{"name":7}'), Schema));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('name:');
    expect(error.message).not.toContain('7');
  });

  it('names the body itself when the failure has no path', async () => {
    const error = await refusal(parseBody(request('[]'), Schema));
    expect(error.message).toContain('the request body is invalid — body:');
  });
});
