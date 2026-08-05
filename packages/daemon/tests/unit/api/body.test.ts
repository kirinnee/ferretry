import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import {
  ApiError,
  MAX_REQUEST_BODY_BYTES,
  MAX_TEXT_BODY_BYTES,
  parseBody,
  parseOptionalBody,
  parseQuery,
} from '../../../src/lib/api/index.ts';
import { MAX_INITIAL_ATTACHMENT_BYTES, MAX_INITIAL_ATTACHMENTS } from '../../../src/lib/attachments/index.ts';
import { bodyReads, request } from './support.ts';

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

describe('bounded body reads', () => {
  const AnySchema = z.object({}).loose();

  /** A body of `bytes` valid JSON, so a refusal cannot be mistaken for a parse failure. */
  const filler = (bytes: number): string => `{"text":"${'a'.repeat(bytes - 11)}"}`;

  it('should ask for the shipped ceiling when a route states no bound of its own', async () => {
    // Arrange
    const reads = bodyReads();
    const subject = request({ body: '{}', reads });

    // Act
    await parseBody(subject, AnySchema);

    // Assert
    should(reads.limits).deepEqual([MAX_REQUEST_BODY_BYTES]);
  });

  it('should accept a body of exactly the route bound', async () => {
    // Arrange
    const subject = request({ body: filler(64) });

    // Act
    const parsed = await parseBody(subject, AnySchema, { maxBytes: 64 });

    // Assert
    should(parsed).have.property('text');
  });

  it('should answer 413 for a body one byte over the route bound', async () => {
    // Arrange
    const subject = request({ body: filler(65) });

    // Act
    const error = await rejection(() => parseBody(subject, AnySchema, { maxBytes: 64 }));

    // Assert
    should(error.status).equal(413);
    should(error.code).equal('body_too_large');
    should(error.message).equal('the request body is over the 64-byte limit');
  });

  it('should refuse a declared oversize before reading the body', async () => {
    // Arrange
    const reads = bodyReads();
    const subject = request({ body: filler(65), headers: { 'content-length': '65' }, reads });

    // Act
    const error = await rejection(() => parseBody(subject, AnySchema, { maxBytes: 64 }));

    // Assert: refused on the declaration alone, with nothing consumed and the rest abandoned.
    should(error.status).equal(413);
    should(reads.consumed).be.false();
    should(reads.discarded).be.true();
  });

  it('should bound a body that forged a small content-length', async () => {
    // Arrange
    const reads = bodyReads();
    const subject = request({
      body: filler(96),
      headers: { 'content-length': '2' },
      bodyPieceBytes: 16,
      reads,
    });

    // Act
    const error = await rejection(() => parseBody(subject, AnySchema, { maxBytes: 64 }));

    // Assert: the read itself refused it, after consuming only what the bound allowed.
    should(error.status).equal(413);
    should(error.code).equal('body_too_large');
    should(reads.consumed).be.true();
  });

  it('should bound a body that declared no length at all', async () => {
    // Arrange
    const subject = request({ body: filler(96), bodyPieceBytes: 16 });

    // Act
    const error = await rejection(() => parseBody(subject, AnySchema, { maxBytes: 64 }));

    // Assert
    should(error.status).equal(413);
  });

  it('should not echo the submitted content in the refusal', async () => {
    // A 413 is the one refusal most likely to be carrying something private.
    // Arrange
    const subject = request({ body: `{"token":"${'sk-live-do-not-log-this'.repeat(8)}"}` });

    // Act
    const error = await rejection(() => parseBody(subject, AnySchema, { maxBytes: 64 }));

    // Assert
    should(error.message).not.containEql('sk-live');
  });

  it('should bound an optional body without making one required', async () => {
    // A route that needs no body at all must still refuse an oversized one, or `POST` with nothing to
    // say becomes an upload.
    // Arrange
    const absent = request({ reads: bodyReads() });
    const oversize = request({ body: filler(96), bodyPieceBytes: 16 });

    // Act
    const parsed = await parseOptionalBody(absent, z.object({ reason: z.string().optional() }).strict(), {
      maxBytes: 64,
    });
    const error = await rejection(() => parseOptionalBody(oversize, AnySchema, { maxBytes: 64 }));

    // Assert
    should(parsed).deepEqual({});
    should(error.status).equal(413);
    should(error.code).equal('body_too_large');
  });

  it('should still answer 400 when the body could not be read at all', async () => {
    // A peer that vanished mid-upload is not an oversized body.
    // Arrange
    const subject = request({ unreadableBody: true });

    // Act
    const error = await rejection(() => parseBody(subject, AnySchema, { maxBytes: 64 }));

    // Assert
    should(error.status).equal(400);
    should(error.code).equal('unreadable_body');
  });
});

describe('MAX_REQUEST_BODY_BYTES', () => {
  /** base64 spends four characters on every three bytes, padded. */
  const encoded = (bytes: number): number => Math.ceil(bytes / 3) * 4;

  it('should admit the largest valid attachment request', async () => {
    // The ceiling is derived from this, and the two numbers live in different modules: an attachment
    // limit raised without raising the transport bound would silently make valid uploads unservable.
    // Arrange
    const largest = encoded(MAX_INITIAL_ATTACHMENT_BYTES);

    // Assert
    should(MAX_REQUEST_BODY_BYTES).be.above(largest);
    should(MAX_REQUEST_BODY_BYTES - largest).be.aboveOrEqual(1024 * 1024);
  });

  it('should admit a full start payload, envelope and opening message included', async () => {
    // Sixteen files sharing the 32 MiB decoded budget, each with its own JSON object and padding,
    // plus the message that names them all.
    // Arrange
    const perFile = `{"filename":"${'n'.repeat(255)}.docx","mime":"application/vnd.openxmlformats","base64":""},`
      .length;
    const payload = encoded(MAX_INITIAL_ATTACHMENT_BYTES) + MAX_INITIAL_ATTACHMENTS * (perFile + 4);
    const opening = 1024 * 1024;

    // Assert
    should(payload + opening).be.below(MAX_REQUEST_BODY_BYTES);
  });

  it('should be far below the runtime default it replaces', async () => {
    // Bun's 128 MiB is not a bound anyone chose; every byte of it is heap an authenticated caller can
    // make the daemon reserve before a schema has looked at the request.
    // Assert
    should(MAX_REQUEST_BODY_BYTES).be.below(128 * 1024 * 1024);
    should(MAX_REQUEST_BODY_BYTES).equal(48_933_548);
  });
});

describe('MAX_TEXT_BODY_BYTES', () => {
  it('should bound a bulk-text route near its own contract, not near the attachment ceiling', async () => {
    // A route whose purpose is to carry a caller's own text — a fleet proposal's asset edits, bounded
    // at 256 KiB across at most 32 files — must not inherit a bound sized for a 32 MiB attachment.
    // Arrange
    const assetEditContract = 256 * 1024;

    // Assert: room for the JSON envelope and escaping, and still two orders of magnitude tighter.
    should(MAX_TEXT_BODY_BYTES).be.above(assetEditContract);
    should(MAX_TEXT_BODY_BYTES).be.belowOrEqual(assetEditContract * 2);
    should(MAX_TEXT_BODY_BYTES * 32).be.below(MAX_REQUEST_BODY_BYTES);
  });

  it('should refuse an oversized bulk-text body with the same stable answer', async () => {
    // Arrange
    const subject = request({ body: 'a'.repeat(MAX_TEXT_BODY_BYTES + 1), bodyPieceBytes: 64 * 1024 });

    // Act
    const error = await rejection(() => parseBody(subject, z.object({}).loose(), { maxBytes: MAX_TEXT_BODY_BYTES }));

    // Assert
    should(error.status).equal(413);
    should(error.code).equal('body_too_large');
    should(error.message).equal(`the request body is over the ${MAX_TEXT_BODY_BYTES}-byte limit`);
  });
});
