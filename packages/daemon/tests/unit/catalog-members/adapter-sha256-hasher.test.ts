import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import should from 'should';
import { NodeShareCodeHasher } from '../../../src/adapters/catalog-members/sha256-hasher.ts';

describe('NodeShareCodeHasher', () => {
  const hasher = new NodeShareCodeHasher();

  it('hashes the published SHA-256 test vector for "abc" as lowercase hex', () => {
    should(hasher.hex('abc')).equal('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the empty text too', () => {
    should(hasher.hex('')).equal('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('is 64 lowercase hex characters, the same for the same text and different for another', () => {
    const code = `fy_share_${'A'.repeat(22)}`;

    should(hasher.hex(code)).match(/^[0-9a-f]{64}$/u);
    should(hasher.hex(code)).equal(hasher.hex(code));
    should(hasher.hex(code)).not.equal(hasher.hex(`${code}x`));
  });

  it('hashes the UTF-8 bytes of the text', () => {
    should(hasher.hex('é')).equal(
      createHash('sha256')
        .update(Buffer.from([0xc3, 0xa9]))
        .digest('hex'),
    );
  });

  it('answers synchronously, as the admission step cannot await a digest', () => {
    should(typeof hasher.hex('x')).equal('string');
  });
});
