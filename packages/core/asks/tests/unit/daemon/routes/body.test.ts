import { describe, it } from 'bun:test';
import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import should from 'should';
import { z } from 'zod';
import { parseBody } from '../../../../daemon/lib/routes/body.ts';

const schema = z.object({ answer: z.string().default('none'), count: z.number().optional() });

/** A request whose body is the given text, or unreadable. */
const requestWith = (body: string | Error): ApiRequest =>
  ({
    text: async () => (body instanceof Error ? await Promise.reject(body) : body),
  }) as unknown as ApiRequest;

const refusalOf = async (request: ApiRequest): Promise<ApiError> => {
  try {
    await parseBody(request, schema);
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('expected the body to be refused');
};

describe('parseBody', () => {
  it('should parse a body that satisfies the schema', async () => {
    should(await parseBody(requestWith('{"answer":"yes","count":2}'), schema)).eql({ answer: 'yes', count: 2 });
  });

  it('should treat an empty or blank body as an empty object', async () => {
    should(await parseBody(requestWith(''), schema)).eql({ answer: 'none' });
    should(await parseBody(requestWith('  \n'), schema)).eql({ answer: 'none' });
  });

  it('should refuse a body that cannot be read', async () => {
    // Act
    const error = await refusalOf(requestWith(new Error('socket closed')));

    // Assert
    should(error).be.instanceOf(ApiError);
    should(error.status).equal(400);
    should(error.code).equal('unreadable_body');
    should(error.message).equal('the request body could not be read');
  });

  it('should refuse a body that is not JSON', async () => {
    // Act
    const error = await refusalOf(requestWith('{nope'));

    // Assert
    should(error.status).equal(400);
    should(error.code).equal('invalid_json');
  });

  it('should name the failing paths without echoing the submitted values', async () => {
    // Act
    const error = await refusalOf(requestWith('{"count":"secret-looking-value"}'));
    const bodyError = await refusalOf(requestWith('[]'));

    // Assert
    should(error.code).equal('invalid_request');
    should(error.message).startWith('the request body is invalid — count: ');
    should(error.message).not.containEql('secret-looking-value');
    should(bodyError.message).startWith('the request body is invalid — body: ');
  });
});
