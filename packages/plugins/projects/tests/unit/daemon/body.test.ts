import { describe, expect, test } from 'bun:test';
import type { ApiRequest } from '@ferretry/kernel/contract';
import { RegisterProjectRequestSchema } from '../../../contract/index.ts';
import { parseBody } from '../../../daemon/lib/body.ts';

/** A request whose body read does what the test says; the limit it was asked for is written down. */
const bodyOf = (read: (limit: number) => Promise<string>, asked: number[] = []): ApiRequest =>
  ({
    text: async (limit: number) => {
      asked.push(limit);
      return await read(limit);
    },
  }) as unknown as ApiRequest;

const refusalOf = async (request: ApiRequest) => {
  try {
    await parseBody(request, RegisterProjectRequestSchema);
  } catch (error) {
    return error as { status: number; code: string; message: string; validationIssues?: unknown[] };
  }
  throw new Error('the body was accepted');
};

describe('the registry routes’ body parsing', () => {
  test('reads at most 64 KiB and answers the parsed, validated value', async () => {
    const asked: number[] = [];
    const parsed = await parseBody(
      bodyOf(async () => JSON.stringify({ kind: 'existing-folder', path: '/work/alpha' }), asked),
      RegisterProjectRequestSchema,
    );
    expect(parsed).toMatchObject({ kind: 'existing-folder', path: '/work/alpha' });
    expect(asked).toEqual([64 * 1024]);
  });

  test('a body past the bound is 413 with the read’s own words', async () => {
    const tooLarge = Object.assign(new Error('the body is over 65536 bytes'), { name: 'BodyTooLargeError' });
    const refusal = await refusalOf(
      bodyOf(async () => {
        throw tooLarge;
      }),
    );
    expect(refusal).toMatchObject({ status: 413, code: 'body_too_large', message: 'the body is over 65536 bytes' });
  });

  test('a body that cannot be read for another reason is 400, and does not echo the failure', async () => {
    const failed = await refusalOf(
      bodyOf(async () => {
        throw new Error('socket reset at 10.0.0.7');
      }),
    );
    expect(failed).toMatchObject({
      status: 400,
      code: 'unreadable_body',
      message: 'the request body could not be read',
    });
    const notAnError = await refusalOf(
      bodyOf(async () => {
        throw 'a bare string';
      }),
    );
    expect(notAnError).toMatchObject({ status: 400, code: 'unreadable_body' });
  });

  test('text that is not JSON is 400 invalid_json', async () => {
    expect(await refusalOf(bodyOf(async () => '{not json'))).toMatchObject({ status: 400, code: 'invalid_json' });
  });

  test('a misfit names the failing paths and never the submitted values', async () => {
    const wrongKind = await refusalOf(
      bodyOf(async () => JSON.stringify({ kind: 'nonsense', path: '/work/secret-value' })),
    );
    expect(wrongKind).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(wrongKind.message).toContain('the request body is invalid — ');
    expect(wrongKind.message).toContain('kind: ');
    expect(wrongKind.message).not.toContain('secret-value');
    expect(wrongKind.validationIssues?.length).toBeGreaterThan(0);
  });

  test('a body that is not an object at all is named as the body itself', async () => {
    const refusal = await refusalOf(bodyOf(async () => 'null'));
    expect(refusal).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(refusal.message).toMatch(/^the request body is invalid — body: /u);
  });
});
