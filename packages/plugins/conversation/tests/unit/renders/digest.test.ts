import { describe, it } from 'bun:test';
import { RenderIdSchema } from '../../../contract/index.ts';
import { RENDER_ID_MAX_LENGTH } from '../../../daemon/renders/lib/constants.ts';
import should from 'should';
import { renderDigest, renderIdPrefix } from '../../../daemon/renders/lib/index.ts';

describe('renderDigest', () => {
  it('should be the same for the same kind, alt and payload and different otherwise', () => {
    should(renderDigest('svg', 'a', 'b').equals(renderDigest('svg', 'a', 'b'))).be.true();
    should(renderDigest('svg', 'a', 'b').equals(renderDigest('html', 'a', 'b'))).be.false();
    should(renderDigest('svg', 'a', 'b').equals(renderDigest('svg', 'ab', ''))).be.false();
  });
});

describe('renderIdPrefix', () => {
  it('should spell the digest in lowercase Crockford base32, five bits a character', () => {
    // 0xff 0x00 ... : 11111 11100 00000 ... => 31, 28, 0 => z, w, 0
    const digest = Uint8Array.from([0xff, 0x00, 0x00, 0x00, 0x00]);
    should(renderIdPrefix(digest, 3)).equal('zw0');
  });

  it('should give a prefix of the longer id at every length, and a valid id', () => {
    const digest = renderDigest('svg', 'alt', 'payload');
    const full = renderIdPrefix(digest, RENDER_ID_MAX_LENGTH);
    should(full).have.length(RENDER_ID_MAX_LENGTH);
    for (const length of [6, 8, 12, 20, 52]) {
      should(renderIdPrefix(digest, length)).equal(full.slice(0, length));
      should(RenderIdSchema.safeParse(renderIdPrefix(digest, length)).success).be.true();
    }
  });
});
