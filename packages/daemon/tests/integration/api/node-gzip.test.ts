import { describe, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import should from 'should';
import { NodeGzip } from '../../../src/adapters/api/node-gzip.ts';

/** The response compressor on the real zlib: what it makes decompresses to the text, and a repeat is not redone. */
describe('NodeGzip', () => {
  it('should compress to bytes that decompress to the text', async () => {
    // Arrange
    const text = JSON.stringify(Array.from({ length: 200 }, (_, at) => ({ at, name: 'session' })));

    // Act
    const gzip = await new NodeGzip().gzip(text);

    // Assert
    should(new TextDecoder().decode(gunzipSync(gzip))).equal(text);
    should(gzip.byteLength).be.below(text.length);
  });

  it('should answer the same text again with the bytes it already made, and new text afresh', async () => {
    // Arrange
    const subject = new NodeGzip();
    const first = await subject.gzip('a'.repeat(5_000));

    // Act
    const [again, concurrent] = await Promise.all([subject.gzip('a'.repeat(5_000)), subject.gzip('a'.repeat(5_000))]);
    const other = await subject.gzip('b'.repeat(5_000));

    // Assert
    should(again).equal(first);
    should(concurrent).equal(first);
    should(new TextDecoder().decode(gunzipSync(other))).equal('b'.repeat(5_000));
  });

  it('should forget a compression that failed, so the next ask tries again', async () => {
    // Arrange — zlib refuses a value that is not text or bytes.
    const subject = new NodeGzip();
    const refused = Symbol('not text') as unknown as string;

    // Act
    const failure = await subject.gzip(refused).then(
      () => undefined,
      (error: unknown) => error,
    );
    const after = await subject.gzip('c'.repeat(5_000));

    // Assert
    should(failure).be.an.instanceOf(Error);
    should(new TextDecoder().decode(gunzipSync(after))).equal('c'.repeat(5_000));
  });
});
