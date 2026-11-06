import { describe, it } from 'bun:test';
import should from 'should';
import type { ApiResponse } from '../../../src/lib/api/http.ts';
import { isPublishedResponse, publishResponse } from '../../../src/lib/api/response-generation.ts';

describe('a published wire response', () => {
  it('should own its containers and expose copies, keeping the generation immutable', () => {
    // Arrange
    const headers = new Map([['one', '1']]);
    // Buffer.slice aliases its source: the publication must own a real copy for this subtype too.
    const gzip = Buffer.from([1, 2, 3]);
    const source = { status: 200, headers, body: 'body', gzip, endsSession: true as const };
    const actual = publishResponse(source);

    // Act — edits before republishing must not change an already sealed generation.
    headers.set('one', 'changed');
    gzip[1] = 8;
    (actual.headers as Map<string, string>).set('one', 'escaped');
    actual.gzip?.fill(9);
    const next = publishResponse(source);

    // Assert — only the explicit publication advances the source's generation.
    should(Object.isFrozen(actual)).be.true();
    should(actual.headers.get('one')).equal('1');
    should(actual.gzip).eql(Uint8Array.of(1, 2, 3));
    should(actual.endsSession).be.true();
    should(next).not.equal(actual);
    should(next.headers.get('one')).equal('changed');
    should(next.gzip).eql(Uint8Array.of(1, 8, 3));
    should(isPublishedResponse(actual)).be.true();
    should(isPublishedResponse({ ...actual })).be.false();
  });

  it('should publish plain answers without inventing compression, a late source or a session end', () => {
    // Arrange
    const source: ApiResponse = { status: 200, headers: new Map(), body: 'plain', late: () => sourcePlain };
    const sourcePlain = { status: 200, headers: new Map(), body: 'later' };

    // Act
    const actual = publishResponse(source);

    // Assert
    should(actual.body).equal('plain');
    should(actual.gzip).be.undefined();
    should(actual.late).be.undefined();
    should(actual.endsSession).be.undefined();
  });

  it('should require a publication before a late source can carry gzip', () => {
    // Arrange
    const raw = { status: 200, headers: new Map<string, string>(), body: 'plain', gzip: Uint8Array.of(1) };
    const invalid: ApiResponse = {
      ...raw,
      // @ts-expect-error mutable gzip is forbidden in a late answer
      late: () => raw,
    };

    // Act
    const valid: ApiResponse = { ...raw, late: () => publishResponse(raw) };
    const published = publishResponse(raw);
    const copied: ApiResponse = {
      ...raw,
      // @ts-expect-error spreading a publication loses its immutable-generation proof
      late: () => ({ ...published, gzip: raw.gzip }),
    };

    // Assert — the invalid fixture also pins the compile-time refusal under the typecheck gate.
    should(isPublishedResponse(invalid)).be.false();
    should(isPublishedResponse(copied.late?.() ?? raw)).be.false();
    should(isPublishedResponse(valid.late?.() ?? raw)).be.true();
  });
});
