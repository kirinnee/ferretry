import { describe, expect, it } from 'bun:test';
import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { parseBody, parseOptionalBody } from '../../../daemon/lib/body.ts';

const schema = z.strictObject({ name: z.string() });

/** A request that answers its body read with `text`, or fails it with what `text` throws. */
const requestWith = (text: (limit: number) => Promise<string>): ApiRequest => ({ text }) as unknown as ApiRequest;

const refusal = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('the body was accepted');
};

describe('how Access reads a request body', () => {
  it('answers the parsed body, reading it no further than the limit it was given', async () => {
    const limits: number[] = [];
    const request = requestWith(async limit => {
      limits.push(limit);
      return '{"name":"phone"}';
    });
    expect(await parseBody(request, schema, { maxBytes: 64 })).toEqual({ name: 'phone' });
    expect(limits).toEqual([64]);
  });

  it('tells a body over the limit only the daemon’s own number: 413 body_too_large, never the bytes', async () => {
    const tooLarge = Object.assign(new Error('the request body is over 64 bytes'), { name: 'BodyTooLargeError' });
    const error = await refusal(
      parseBody(
        requestWith(async () => {
          throw tooLarge;
        }),
        schema,
      ),
    );
    expect(error.status).toBe(413);
    expect(error.code).toBe('body_too_large');
    expect(error.message).toBe('the request body is over 64 bytes');
  });

  it('tells a body that cannot be read at all 400 unreadable_body, without the transport’s words', async () => {
    const error = await refusal(
      parseOptionalBody(
        requestWith(async () => {
          throw new Error('socket hang up while reading sk-fixture-secret');
        }),
        schema,
      ),
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe('unreadable_body');
    expect(error.message).not.toContain('sk-fixture-secret');
  });

  it('refuses text that is not JSON as 400 invalid_json, for a required body and an optional one alike', async () => {
    const request = requestWith(async () => '{"name": ');
    for (const parse of [parseBody, parseOptionalBody]) {
      const error = await refusal(parse(request, schema));
      expect(error.status).toBe(400);
      expect(error.code).toBe('invalid_json');
    }
  });

  it('names the failing fields of a body that parses but does not fit, without echoing what was sent', async () => {
    const error = await refusal(
      parseBody(
        requestWith(async () => '{"name":7,"extra":"sk-fixture-secret"}'),
        schema,
      ),
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('name:');
    expect(error.message).not.toContain('sk-fixture-secret');
  });

  it('reads an empty or blank optional body as the no-fields case, but not a required one', async () => {
    const optional = z.strictObject({ name: z.string().optional() });
    expect(
      await parseOptionalBody(
        requestWith(async () => '  \n'),
        optional,
      ),
    ).toEqual({});
    expect(
      (
        await refusal(
          parseBody(
            requestWith(async () => ''),
            schema,
          ),
        )
      ).code,
    ).toBe('invalid_json');
  });
});
