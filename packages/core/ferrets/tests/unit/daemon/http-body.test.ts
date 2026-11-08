import { describe, expect, it } from 'bun:test';
import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { BodyTooLargeError, parseBody, parseOptionalBody } from '../../../daemon/lib/http/body.ts';

const schema = z.strictObject({ name: z.string() });

const requestOf = (text: (limit?: number) => Promise<string>): ApiRequest => ({ text }) as unknown as ApiRequest;
const bodyOf = (body: string): ApiRequest => requestOf(async () => body);
const failing = (error: unknown): ApiRequest =>
  requestOf(async () => {
    throw error;
  });

const refusal = async (work: Promise<unknown>): Promise<ApiError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
};

describe('a request body is read bounded, then parsed against its schema', () => {
  it('parses a valid body and an absent optional body', async () => {
    expect(await parseBody(bodyOf('{"name":"wren"}'), schema)).toEqual({ name: 'wren' });
    expect(await parseOptionalBody(bodyOf('   '), z.object({ note: z.string().optional() }))).toEqual({});
    expect(await parseOptionalBody(bodyOf('{"name":"ash"}'), schema)).toEqual({ name: 'ash' });
  });

  it('answers 413 body_too_large naming the daemon number when the read is over the limit', async () => {
    const asked: (number | undefined)[] = [];
    const request = requestOf(async limit => {
      asked.push(limit);
      throw new ApiError(413, 'too big', 'body_too_large');
    });
    const error = await refusal(parseBody(request, schema, { maxBytes: 10 }));
    expect(error).toBeInstanceOf(BodyTooLargeError);
    expect(error.status).toBe(413);
    expect(error.message).toBe('the request body is over the 10-byte limit');
    expect((error as BodyTooLargeError).limitBytes).toBe(10);
    expect(asked).toEqual([10]);
  });

  it('answers 400 unreadable_body when the body cannot be read for any other reason', async () => {
    const error = await refusal(parseBody(failing(new Error('socket closed')), schema));
    expect(error.status).toBe(400);
    expect(error.message).toBe('the request body could not be read');
    const other = await refusal(parseOptionalBody(failing(new ApiError(500, 'boom', 'boom')), schema));
    expect(other.status).toBe(400);
  });

  it('answers 400 invalid_json for a body that is not JSON', async () => {
    const error = await refusal(parseBody(bodyOf('{nope'), schema));
    expect(error.status).toBe(400);
    expect(error.message).toBe('the request body is not valid JSON');
  });
});
