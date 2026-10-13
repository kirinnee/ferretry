import { describe, it } from 'bun:test';
import should from 'should';
import { decodeCbor, decodeCborItem, isCborMap, MAX_CBOR_DEPTH } from '../../../src/lib/passkeys/index.ts';
import { cbor } from '../../support/passkey-authenticator.ts';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('decodeCbor', () => {
  it('should decode every item the attestation object and COSE key use', () => {
    // Arrange
    const encoded = cbor(
      new Map<number | string, Parameters<typeof cbor>[0]>([
        [1, 2],
        [-1, -257],
        ['fmt', 'none'],
        ['bytes', bytes(1, 2, 3)],
        ['list', [true, false, null, 0, 23, 24, 255, 256, 65535, 65536]],
      ]),
    );

    // Act
    const value = decodeCbor(encoded);

    // Assert
    should(isCborMap(value)).be.true();
    const map = value as ReadonlyMap<number | string, unknown>;
    should(map.get(1)).equal(2);
    should(map.get(-1)).equal(-257);
    should(map.get('fmt')).equal('none');
    should(Array.from(map.get('bytes') as Uint8Array)).deepEqual([1, 2, 3]);
    should(map.get('list')).deepEqual([true, false, null, 0, 23, 24, 255, 256, 65535, 65536]);
  });

  it('should decode an 8-byte argument while it stays a safe integer, and refuse one that does not', () => {
    // Arrange
    const safe = bytes(0x1b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
    const unsafe = bytes(0x1b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);

    // Act / Assert
    should(decodeCbor(safe)).equal(Number.MAX_SAFE_INTEGER);
    should(decodeCbor(unsafe)).be.undefined();
  });

  it('should refuse trailing bytes after the one item', () => {
    should(decodeCbor(bytes(0x01, 0x02))).be.undefined();
  });

  it('should report where an item ends so the bytes that follow it can be read', () => {
    should(decodeCborItem(bytes(0xff, 0x63, 0x61, 0x62, 0x63, 0x00), 1)).deepEqual({ value: 'abc', end: 5 });
  });

  it('should refuse every encoding the two documents never use', () => {
    // Arrange — each is one byte sequence a strict reader must not accept.
    const refused: Record<string, Uint8Array> = {
      empty: bytes(),
      'indefinite-length byte string': bytes(0x5f, 0x41, 0x00, 0xff),
      'indefinite-length map': bytes(0xbf, 0xff),
      'reserved additional info': bytes(0x1c),
      tag: bytes(0xc0, 0x00),
      float: bytes(0xf9, 0x00, 0x00),
      undefined: bytes(0xf7),
      'head runs past the buffer': bytes(0x19, 0x01),
      'byte string past the buffer': bytes(0x42, 0x00),
      'text string past the buffer': bytes(0x62, 0x61),
      'text string that is not UTF-8': bytes(0x61, 0xff),
      'array count larger than the buffer': bytes(0x85, 0x00),
      'array item that is refused': bytes(0x81, 0xf7),
      'map count larger than the buffer': bytes(0xa2, 0x00, 0x00),
      'map key that is refused': bytes(0xa1, 0xf7, 0x00),
      'map key that is not a scalar': bytes(0xa1, 0x80, 0x00),
      'map key that is a boolean': bytes(0xa1, 0xf5, 0x00),
      'duplicate map key': bytes(0xa2, 0x01, 0x00, 0x01, 0x00),
      'map value that is refused': bytes(0xa1, 0x01, 0xf7),
    };

    // Act / Assert
    const accepted = Object.entries(refused).filter(([, encoded]) => decodeCbor(encoded) !== undefined);
    should(accepted.map(([name]) => name)).deepEqual([]);
  });

  it(`should accept nesting to depth ${MAX_CBOR_DEPTH} and refuse one level deeper`, () => {
    // Arrange — depth counts the containers above an item, so N+1 arrays put the leaf at depth N+1.
    const nested = (levels: number) => Uint8Array.from([...Array.from({ length: levels }, () => 0x81), 0x00]);

    // Act / Assert
    should(decodeCbor(nested(MAX_CBOR_DEPTH))).not.be.undefined();
    should(decodeCbor(nested(MAX_CBOR_DEPTH + 1))).be.undefined();
  });
});
