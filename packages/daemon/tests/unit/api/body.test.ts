import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { ApiError, parseBody, parseOptionalBody, parseQuery } from '../../../src/lib/api/index.ts';
import { request } from './support.ts';

const SendSchema = z.object({ text: z.string().min(1), urgent: z.boolean().default(false) }).strict();
const PageSchema = z.object({ limit: z.coerce.number().int().positive().max(100).default(20) });

/** Runs `act` and returns the ApiError it threw. Fails the test if it did not throw one. */
async function rejection(act: () => Promise<unknown>): Promise<ApiError> {
  try {
    await act();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the parse to be rejected');
}

describe('parseBody', () => {
  it('should return the parsed value, defaults applied', async () => {
    // Arrange
    const subject = request({ body: JSON.stringify({ text: 'hello' }) });

    // Act
    const parsed = await parseBody(subject, SendSchema);

    // Assert
    should(parsed).deepEqual({ text: 'hello', urgent: false });
  });

  it('should reject a body that is not JSON', async () => {
    // Arrange
    const subject = request({ body: 'not json' });

    // Act
    const error = await rejection(() => parseBody(subject, SendSchema));

    // Assert
    should(error.status).equal(400);
    should(error.code).equal('invalid_json');
  });

  it('should reject a body that does not satisfy the schema and name the field', async () => {
    // A cast at the HTTP boundary is how a wrong shape reaches the domain and fails three layers
    // down as a 500.
    // Arrange
    const subject = request({ body: JSON.stringify({ text: '' }) });

    // Act
    const error = await rejection(() => parseBody(subject, SendSchema));

    // Assert
    should(error.status).equal(400);
    should(error.code).equal('invalid_request');
    should(error.message).containEql('text');
  });

  it('should reject an unknown field rather than silently dropping it', async () => {
    // Arrange
    const subject = request({ body: JSON.stringify({ text: 'hi', urgnet: true }) });

    // Act
    const error = await rejection(() => parseBody(subject, SendSchema));

    // Assert
    should(error.status).equal(400);
  });

  it('should not echo the submitted value back in the error', async () => {
    // Arrange
    const subject = request({ body: JSON.stringify({ text: 'sk-live-do-not-log-this' }) });

    // Act
    const error = await rejection(() => parseBody(subject, z.object({ text: z.number() })));

    // Assert
    should(error.message).not.containEql('sk-live-do-not-log-this');
  });

  it('should reject a body the transport could not read', async () => {
    // Arrange
    const subject = request({ unreadableBody: true });

    // Act
    const error = await rejection(() => parseBody(subject, SendSchema));

    // Assert
    should(error.status).equal(400);
    should(error.code).equal('unreadable_body');
  });
});

describe('parseOptionalBody', () => {
  const OptionalSchema = z.object({ reason: z.string().optional() }).strict();

  it('should treat an absent body as the no-fields case', async () => {
    // Arrange / Act
    const parsed = await parseOptionalBody(request(), OptionalSchema);

    // Assert
    should(parsed).deepEqual({});
  });

  it('should treat a whitespace-only body as the no-fields case', async () => {
    // Arrange / Act
    const parsed = await parseOptionalBody(request({ body: '   \n' }), OptionalSchema);

    // Assert
    should(parsed).deepEqual({});
  });

  it('should still parse a body that is present', async () => {
    // Arrange / Act
    const parsed = await parseOptionalBody(request({ body: '{"reason":"stalled"}' }), OptionalSchema);

    // Assert
    should(parsed).deepEqual({ reason: 'stalled' });
  });

  it('should reject malformed JSON rather than downgrading it to no fields', async () => {
    // Silently treating a broken body as `{}` drops a field the caller meant to send.
    // Arrange / Act
    const error = await rejection(() => parseOptionalBody(request({ body: '{"reason":' }), OptionalSchema));

    // Assert
    should(error.code).equal('invalid_json');
  });

  it('should reject a non-object body', async () => {
    // Arrange / Act
    const error = await rejection(() => parseOptionalBody(request({ body: '"just a string"' }), OptionalSchema));

    // Assert
    should(error.status).equal(400);
  });
});

describe('parseQuery', () => {
  it('should parse and coerce the first value of each key', async () => {
    // Arrange
    const subject = request({
      query: [
        ['limit', '5'],
        ['limit', '999'],
      ],
    });

    // Act
    const parsed = parseQuery(subject, PageSchema);

    // Assert
    should(parsed).deepEqual({ limit: 5 });
  });

  it('should apply defaults when a key is absent', async () => {
    // Arrange / Act
    const parsed = parseQuery(request(), PageSchema);

    // Assert
    should(parsed).deepEqual({ limit: 20 });
  });

  it('should reject a value outside the schema bounds', async () => {
    // Arrange
    const subject = request({ query: [['limit', '5000']] });

    // Act
    const error = await rejection(async () => parseQuery(subject, PageSchema));

    // Assert
    should(error.status).equal(400);
    should(error.message).containEql('limit');
  });

  it('should name the surface when the failure is not attached to a field', async () => {
    // Arrange / Act
    const error = await rejection(async () => parseQuery(request(), z.string()));

    // Assert
    should(error.message).containEql('query');
  });
});

describe('ApiError', () => {
  it('should carry its status and code', () => {
    // Arrange / Act
    const error = new ApiError(409, 'conflict', 'already_running');

    // Assert
    should(error.status).equal(409);
    should(error.code).equal('already_running');
    should(error.name).equal('ApiError');
    should(error).be.instanceof(Error);
  });
});
