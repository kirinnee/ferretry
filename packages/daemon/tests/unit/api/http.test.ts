import { describe, it } from 'bun:test';
import should from 'should';
import {
  BodyTooLargeError,
  type BoundedBodySource,
  decodeParameter,
  headerValue,
  queryFrom,
  queryValue,
  queryValues,
  readBoundedBody,
} from '../../../src/lib/api/index.ts';
import { request } from './support.ts';

describe('header access', () => {
  it('should read a header regardless of the case it was sent in', () => {
    // Arrange
    const subject = request({ headers: { AuThOrIzAtIoN: 'Bearer x' } });

    // Act / Assert
    should(headerValue(subject, 'authorization')).equal('Bearer x');
    should(headerValue(subject, 'AUTHORIZATION')).equal('Bearer x');
  });

  it('should report an absent header as undefined', () => {
    // Arrange / Act / Assert
    should(headerValue(request(), 'authorization')).be.undefined();
  });
});

describe('query access', () => {
  it('should keep every value of a repeated key in order', () => {
    // Arrange
    const subject = request({
      query: [
        ['sessionId', 'a'],
        ['sessionId', 'b'],
      ],
    });

    // Act / Assert
    should(queryValues(subject, 'sessionId')).deepEqual(['a', 'b']);
  });

  it('should take the first value for a single-valued read', () => {
    // Arrange
    const subject = request({
      query: [
        ['after', '10'],
        ['after', '20'],
      ],
    });

    // Act / Assert
    should(queryValue(subject, 'after')).equal('10');
  });

  it('should report an absent key as an empty list and undefined', () => {
    // Arrange / Act / Assert
    should(queryValues(request(), 'missing')).deepEqual([]);
    should(queryValue(request(), 'missing')).be.undefined();
  });

  it('should build the map from repeated pairs', () => {
    // Arrange / Act
    const query = queryFrom([
      ['a', '1'],
      ['b', '2'],
      ['a', '3'],
    ]);

    // Assert
    should(query.get('a')).deepEqual(['1', '3']);
    should(query.get('b')).deepEqual(['2']);
  });
});

describe('decodeParameter', () => {
  const cases: readonly (readonly [string, string | undefined])[] = [
    ['plain', 'plain'],
    ['with%20space', 'with space'],
    ['%2e%2e', undefined],
    ['..', undefined],
    ['.', undefined],
    ['%2f', undefined],
    ['a%2fb', undefined],
    ['a%5cb', undefined],
    ['a%00b', undefined],
    ['%zz', undefined],
    ['%', undefined],
  ];

  for (const [raw, expected] of cases) {
    it(`should decode "${raw}" to ${String(expected)}`, () => {
      // Arrange / Act / Assert
      should(decodeParameter(raw)).equal(expected);
    });
  }
});

describe('readBoundedBody', () => {
  /** A source whose pieces are handed over one at a time, counting what it was actually asked for. */
  function source(
    pieces: readonly (string | Uint8Array)[],
    declaredLength?: string,
    /**
     * How abandoning the body fails, if it does.
     *
     * `reject` is a rejected promise, the way cancelling an already-failed stream behaves. `throw`
     * is a `discard` that never returns a promise at all — a plain function that throws satisfies
     * the `Promise<void>` signature, because `never` is assignable to anything — and it is the case
     * a `.catch()` on the returned promise cannot reach.
     */
    discardFailure?: 'reject' | 'throw',
  ): { readonly source: BoundedBodySource; readonly produced: () => number; readonly discarded: () => number } {
    let produced = 0;
    let discarded = 0;
    const rejectingDiscard = async (): Promise<void> => {
      discarded += 1;
      if (discardFailure === 'reject') throw new Error('the stream was already broken');
    };
    const throwingDiscard = (): Promise<void> => {
      discarded += 1;
      throw new Error('the stream was already broken');
    };
    return {
      produced: () => produced,
      discarded: () => discarded,
      source: {
        declaredLength,
        chunks: async function* () {
          for (const piece of pieces) {
            produced += 1;
            yield typeof piece === 'string' ? new TextEncoder().encode(piece) : piece;
          }
        },
        discard: discardFailure === 'throw' ? throwingDiscard : rejectingDiscard,
      },
    };
  }

  /** Runs `act` and returns the refusal it made. Fails the test if it did not refuse. */
  async function refusal(act: () => Promise<unknown>): Promise<BodyTooLargeError> {
    try {
      await act();
    } catch (error) {
      if (error instanceof BodyTooLargeError) return error;
      throw error;
    }
    throw new Error('expected the read to be refused');
  }

  it('should join the pieces of a body that fits', async () => {
    // Arrange
    const body = source(['{"text":', '"hello"}']);

    // Act / Assert
    should(await readBoundedBody(body.source, 64)).equal('{"text":"hello"}');
  });

  it('should accept a body of exactly the bound', async () => {
    // The boundary is inclusive on purpose: a client told the limit is N must be able to send N.
    // Arrange
    const body = source(['0123456789']);

    // Act / Assert
    should(await readBoundedBody(body.source, 10)).equal('0123456789');
  });

  it('should refuse a body one byte over the bound', async () => {
    // Arrange
    const body = source(['0123456789!']);

    // Act
    const error = await refusal(() => readBoundedBody(body.source, 10));

    // Assert
    should(error.limitBytes).equal(10);
    should(error.message).equal('the request body is over the 10-byte limit');
  });

  it('should refuse a declared oversize without reading a single piece', async () => {
    // The whole point of the pre-check: an oversized upload has to be cheap to turn away.
    // Arrange
    const body = source(['0123456789!'], '11');

    // Act
    const error = await refusal(() => readBoundedBody(body.source, 10));

    // Assert: refused unread — and the rest abandoned, or the sender would keep sending it.
    should(error.limitBytes).equal(10);
    should(body.produced()).equal(0);
    should(body.discarded()).equal(1);
  });

  it('should abandon the rest of a body refused mid-read', async () => {
    // Arrange
    const body = source(['0123', '4567', '89!']);

    // Act
    await refusal(() => readBoundedBody(body.source, 10));

    // Assert: exactly once, on the one path that refused.
    should(body.discarded()).equal(1);
  });

  it('should leave a body it read to the end alone', async () => {
    // Abandoning belongs to refusal. A body that arrived complete has nothing left to stop, and
    // discarding it anyway would report a fault on a request that succeeded.
    // Arrange
    const body = source(['0123456789'], '10');

    // Act
    await readBoundedBody(body.source, 10);

    // Assert
    should(body.discarded()).equal(0);
  });

  // Both ways a body can be refused — turned away on the length it declared, and stopped part-way
  // through one that declared nothing — against both ways abandoning it can fail.
  const paths: readonly (readonly [string, string | undefined])[] = [
    ['a declared', '11'],
    ['an undeclared', undefined],
  ];
  const failures: readonly (readonly [string, 'reject' | 'throw'])[] = [
    ['rejects', 'reject'],
    ['throws before returning a promise', 'throw'],
  ];

  for (const [description, declared] of paths) {
    for (const [failureDescription, discardFailure] of failures) {
      it(`should keep the refusal when abandoning ${description} oversize body ${failureDescription}`, async () => {
        // Abandoning a stream that has already broken fails with the very error that broke it.
        // Letting that through would replace a 413 the client can act on with one it cannot — or
        // leave the rejection unhandled, which is a failed test somewhere else entirely.
        //
        // The `throw` case is the one a `.catch()` on the returned promise cannot reach: there is
        // no promise to attach it to, so the cleanup fault escapes and becomes the answer. Both are
        // exercised here because the two look identical in source and only one used to be covered.
        // Arrange
        const body = source(['0123456789!'], declared, discardFailure);

        // Act
        const error = await refusal(() => readBoundedBody(body.source, 10));

        // Assert
        should(error).be.instanceof(BodyTooLargeError);
        should(error.limitBytes).equal(10);
        should(error.message).equal('the request body is over the 10-byte limit');
        should(body.discarded()).equal(1);
      });
    }
  }

  it('should still admit a body whose declared length is exactly the bound', async () => {
    // Arrange
    const body = source(['0123456789'], '10');

    // Act / Assert
    should(await readBoundedBody(body.source, 10)).equal('0123456789');
  });

  it('should bound a body that declared a length it is not sending', async () => {
    // A forged `content-length` must buy nothing: the running total is the bound that cannot be lied
    // to.
    // Arrange
    const body = source(['0123', '4567', '89!'], '1');

    // Act
    const error = await refusal(() => readBoundedBody(body.source, 10));

    // Assert: refused mid-upload, with the last piece never appended.
    should(error.limitBytes).equal(10);
    should(body.produced()).equal(3);
  });

  it('should bound a chunked body that declared no length at all', async () => {
    // Arrange
    const body = source(['0123456789', 'more']);

    // Act / Assert
    should((await refusal(() => readBoundedBody(body.source, 10))).limitBytes).equal(10);
  });

  const forged: readonly (readonly [string, string])[] = [
    ['not-a-number', 'letters'],
    ['', 'an empty header'],
    ['-1', 'a negative length'],
    ['10.5', 'a fractional length'],
    ['0x40', 'a hexadecimal length'],
    ['99999999999999999999', 'a length no number can hold'],
  ];

  for (const [declared, description] of forged) {
    it(`should treat ${description} as no declaration and bound the read instead`, async () => {
      // A malformed header is a hint the daemon cannot use, never a refusal of its own — answering
      // 400 to it would break the chunked uploads the fallback exists for.
      // Arrange
      const fits = source(['0123456789'], declared);
      const over = source(['0123456789!'], declared);

      // Act / Assert
      should(await readBoundedBody(fits.source, 10)).equal('0123456789');
      should((await refusal(() => readBoundedBody(over.source, 10))).limitBytes).equal(10);
    });
  }

  it('should tolerate whitespace around a declared length', async () => {
    // Arrange
    const body = source(['0123456789!'], ' 11 ');

    // Act / Assert
    should((await refusal(() => readBoundedBody(body.source, 10))).limitBytes).equal(10);
  });

  it('should read an empty body as the empty string', async () => {
    // Arrange
    const body = source([]);

    // Act / Assert
    should(await readBoundedBody(body.source, 10)).equal('');
  });

  it('should rejoin a multi-byte character split across two pieces', async () => {
    // Decoding each piece on its own would turn a split character into replacement bytes, which is a
    // body the JSON parser then rejects for a reason the client cannot act on.
    // Arrange
    const encoded = new TextEncoder().encode('{"n":"café"}');
    const split = encoded.byteLength - 3;
    const body = source([encoded.subarray(0, split), encoded.subarray(split)]);

    // Act / Assert
    should(await readBoundedBody(body.source, 64)).equal('{"n":"café"}');
  });

  it('should let a failure reading the body through unchanged, and not abandon it', async () => {
    // A peer that vanished mid-upload is not an oversized body, and must not be answered as one. Nor
    // is there anything left to stop: the stream that broke is already over.
    // Arrange
    let discarded = 0;
    const dropped: BoundedBodySource = {
      chunks: async function* () {
        yield new TextEncoder().encode('{');
        throw new Error('the connection dropped');
      },
      discard: async () => {
        discarded += 1;
      },
    };

    // Act
    const error = await readBoundedBody(dropped, 64).catch((reason: unknown) => reason);

    // Assert
    should(error).be.instanceof(Error);
    should(error).not.be.instanceof(BodyTooLargeError);
    should((error as Error).message).equal('the connection dropped');
    should(discarded).equal(0);
  });
});

describe('BodyTooLargeError', () => {
  it('should carry the bound it refused, and name nothing the caller sent', () => {
    // Arrange / Act
    const error = new BodyTooLargeError(256 * 1024);

    // Assert
    should(error.name).equal('BodyTooLargeError');
    should(error.limitBytes).equal(262_144);
    should(error.message).equal('the request body is over the 262144-byte limit');
  });
});
