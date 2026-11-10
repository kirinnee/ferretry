import { describe, it } from 'bun:test';
import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import should from 'should';
import { z } from 'zod';
import { parseBody, parseOptionalBody } from '../../daemon/lib/body.ts';
import { nextSystemCallsignSequence } from '../../daemon/lib/foreign.ts';
import { paneLimitHolds } from '../../daemon/lib/foreign-pane-limit.ts';

const schema = z.strictObject({ ferret: z.string().min(1) });

const requestOf = (read: (limit: number) => Promise<string>): ApiRequest => ({ text: read }) as unknown as ApiRequest;
const saying = (text: string) => requestOf(async () => text);

const refusal = async (work: () => Promise<unknown>): Promise<ApiError> => {
  const failure = await work().then(
    () => undefined,
    (error: unknown) => error,
  );
  should(failure).be.instanceOf(ApiError);
  return failure as ApiError;
};

describe('the request body of a Warden route', () => {
  it('should parse a body against its schema', async () => {
    should(await parseBody(saying('{"ferret":"f1"}'), schema)).eql({ ferret: 'f1' });
  });

  it('should tell the caller which field is wrong without echoing what it sent', async () => {
    const error = await refusal(async () => await parseBody(saying('{"ferret":""}'), schema));
    should(error).match({ status: 400, code: 'invalid_request' });
    should(error.message).containEql('ferret:');
    const root = await refusal(async () => await parseBody(saying('"nope"'), schema));
    should(root.message).containEql('the request body is invalid');
  });

  it('should refuse a body that is not JSON', async () => {
    const error = await refusal(async () => await parseBody(saying('{'), schema));
    should(error).match({ status: 400, code: 'invalid_json' });
  });

  it('should answer 413 naming only the limit when the body is too large', async () => {
    const tooLarge = Object.assign(new Error('the body is over 10 bytes'), { name: 'BodyTooLargeError' });
    const error = await refusal(
      async () =>
        await parseBody(
          requestOf(async () => {
            throw tooLarge;
          }),
          schema,
          { maxBytes: 10 },
        ),
    );
    should(error).match({ status: 413, code: 'body_too_large' });
  });

  it('should answer 400 when the body cannot be read at all', async () => {
    const error = await refusal(
      async () =>
        await parseBody(
          requestOf(async () => {
            throw new Error('socket closed');
          }),
          schema,
        ),
    );
    should(error).match({ status: 400, code: 'unreadable_body' });
    should(error.message).not.containEql('socket');
  });

  it('should read an empty optional body as no fields, and still refuse malformed JSON', async () => {
    const optional = z.strictObject({ spawn: z.boolean().default(false) });
    should(await parseOptionalBody(saying('  \n'), optional)).eql({ spawn: false });
    should(await parseOptionalBody(saying('{"spawn":true}'), optional)).eql({ spawn: true });
    should((await refusal(async () => await parseOptionalBody(saying('{'), optional))).code).equal('invalid_json');
  });
});

describe('callsign sequences and pane limits', () => {
  it('should give up when every sequence is taken', () => {
    const everything: ReadonlySet<number> = { has: () => true } as unknown as ReadonlySet<number>;
    should(nextSystemCallsignSequence(0, everything)).be.undefined();
    should(nextSystemCallsignSequence(0, new Set())).equal(1);
  });

  it('should hold a pane limit until its reset time, and for as long as it has none', () => {
    should(paneLimitHolds({ notice: 'n', spend: false }, 100)).be.true();
    should(paneLimitHolds({ notice: 'n', spend: false, retryAt: 200 }, 100)).be.true();
    should(paneLimitHolds({ notice: 'n', spend: false, retryAt: 100 }, 100)).be.false();
  });
});
