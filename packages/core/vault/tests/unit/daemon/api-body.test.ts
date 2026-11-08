import { describe, it } from 'bun:test';
import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import should from 'should';
import { z } from 'zod';
import { parseBody } from '../../../daemon/lib/api/body.ts';

const Schema = z.strictObject({ name: z.string(), nested: z.strictObject({ count: z.number() }).optional() });

const requestWith = (text: () => Promise<string>): ApiRequest => ({ text }) as unknown as ApiRequest;
const refusal = async (request: ApiRequest): Promise<ApiError> => {
  const error = await parseBody(request, Schema).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceof(ApiError);
  return error as ApiError;
};

describe('parseBody', () => {
  it('should hand back the parsed body when it fits the schema', async () => {
    const body = await parseBody(
      requestWith(async () => JSON.stringify({ name: 'x' })),
      Schema,
    );

    should(body).eql({ name: 'x' });
  });

  it('should refuse a body that cannot be read as unreadable_body (400)', async () => {
    const error = await refusal(
      requestWith(async () => {
        throw new Error('over the limit');
      }),
    );

    should(error.status).equal(400);
    should(error.code).equal('unreadable_body');
  });

  it('should refuse a body that is not JSON as invalid_json (400), naming no content', async () => {
    const error = await refusal(requestWith(async () => '{not json'));

    should(error.status).equal(400);
    should(error.code).equal('invalid_json');
    should(error.message).not.containEql('not json');
  });

  it('should refuse a body that breaks the schema, naming each path (body for the root)', async () => {
    const root = await refusal(requestWith(async () => '[]'));
    const nested = await refusal(requestWith(async () => JSON.stringify({ name: 'x', nested: { count: 'many' } })));

    should(root.code).equal('invalid_request');
    should(root.message).containEql('body:');
    should(nested.code).equal('invalid_request');
    should(nested.message).containEql('nested.count:');
  });
});
