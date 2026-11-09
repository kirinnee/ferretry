import { describe, it } from 'bun:test';
import type { ApiRequest } from '@ferretry/kernel/contract';
import { owner, testArrival } from '@ferretry/kernel/testing';
import should from 'should';
import { z } from 'zod';
import { parseBody as parseAccountBody } from '../../../../daemon/lib/body.ts';
import { parseBody } from '../../../../daemon/lib/http/body.ts';

/**
 * The two bounded, schema-parsed body readers. Both answer a refusal in the person's words and never echo what was
 * submitted: a rejected password must not come back out.
 */

const Schema = z.strictObject({ name: z.string(), nested: z.strictObject({ count: z.number() }).optional() });

function requestOf(text: (limit?: number) => Promise<string>): ApiRequest {
  return { method: 'POST', path: '/', query: new Map(), headers: new Map(), arrival: testArrival(owner()), text };
}

const bodyRequest = (text: string) => requestOf(async () => text);

const refusal = async (work: Promise<unknown>) =>
  await work.then(
    () => undefined,
    (error: unknown) => error as { status: number; code: string; message: string; details?: unknown },
  );

describe('parseBody (the routes’ shared reader)', () => {
  it('should hand back the parsed value of a body that satisfies its schema', async () => {
    should(await parseBody(bodyRequest('{"name":"kirin"}'), Schema)).eql({ name: 'kirin' });
  });

  it('should read under the bound the caller names, and the transport bound otherwise', async () => {
    const limits: (number | undefined)[] = [];
    const reading = requestOf(async limit => {
      limits.push(limit);
      return '{"name":"a"}';
    });
    await parseBody(reading, Schema, { maxBytes: 100 });
    await parseBody(reading, Schema);
    should(limits[0]).equal(100);
    // One 32 MiB attachment as base64 plus its envelope: far above a few kilobytes, far below unbounded.
    should(limits[1])
      .be.a.Number()
      .and.above(32 * 1024 * 1024);
    should(limits[1]).be.below(64 * 1024 * 1024);
  });

  it('should answer a body past the bound 413, in the transport’s own words', async () => {
    const tooLarge = Object.assign(new Error('the body is larger than 100 bytes'), { name: 'BodyTooLargeError' });
    const refused = await refusal(
      parseBody(
        requestOf(async () => {
          throw tooLarge;
        }),
        Schema,
      ),
    );
    should(refused).match({ status: 413, code: 'body_too_large', message: 'the body is larger than 100 bytes' });
  });

  it('should answer any other read failure 400 with one sentence that names nothing', async () => {
    for (const failure of [new Error('socket reset'), 'not even an error']) {
      const refused = await refusal(
        parseBody(
          requestOf(async () => {
            throw failure;
          }),
          Schema,
        ),
      );
      should(refused).match({ status: 400, code: 'unreadable_body', message: 'the request body could not be read' });
    }
  });

  it('should refuse text that is not JSON', async () => {
    const refused = await refusal(parseBody(bodyRequest('{ nope'), Schema));
    should(refused).match({ status: 400, code: 'invalid_json', message: 'the request body is not valid JSON' });
  });

  it('should name the failing paths of a body that fails its schema, never the submitted values', async () => {
    const refused = await refusal(
      parseBody(bodyRequest('{"name":"hunter2-SECRET","nested":{"count":"seven-SECRET"}}'), Schema),
    );
    should(refused).match({ status: 400, code: 'invalid_request' });
    should(refused?.message).startWith('the request body is invalid — nested.count: ');
    should(JSON.stringify(refused)).not.containEql('SECRET');
  });

  it('should name the whole body when the failure is at its root', async () => {
    const refused = await refusal(parseBody(bodyRequest('[1]'), Schema));
    should(refused?.message).startWith('the request body is invalid — body: ');
  });
});

describe('parseBody (the accounts’ reader)', () => {
  it('should hand back the parsed value, read under a few kilobytes’ bound', async () => {
    let bound: number | undefined;
    const value = await parseAccountBody(
      requestOf(async limit => {
        bound = limit;
        return '{"name":"kirin"}';
      }),
      Schema,
    );
    should(value).eql({ name: 'kirin' });
    should(bound).equal(512 * 1024);
  });

  it('should answer a read that fails, or text that is not JSON, in one fixed sentence each', async () => {
    const unreadable = await refusal(
      parseAccountBody(
        requestOf(async () => {
          throw new Error('socket reset');
        }),
        Schema,
      ),
    );
    should(unreadable).match({ status: 400, code: 'unreadable_body', message: 'the request body could not be read' });
    const notJson = await refusal(parseAccountBody(bodyRequest('{ nope'), Schema));
    should(notJson).match({ status: 400, code: 'invalid_json', message: 'the request body is not valid JSON' });
  });

  it('should name the failing paths without echoing values, and the body itself when the root fails', async () => {
    const nested = await refusal(
      parseAccountBody(bodyRequest('{"name":"hunter2-SECRET","nested":{"count":"seven-SECRET"}}'), Schema),
    );
    should(nested).match({ status: 400, code: 'invalid_request' });
    should(nested?.message).startWith('the request body is invalid — nested.count: ');
    should(JSON.stringify(nested)).not.containEql('SECRET');
    const root = await refusal(parseAccountBody(bodyRequest('"just a string"'), Schema));
    should(root?.message).startWith('the request body is invalid — body: ');
  });
});
