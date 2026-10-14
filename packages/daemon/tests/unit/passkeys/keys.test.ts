import { describe, it } from 'bun:test';
import should from 'should';
import { coseKeyToSpki, derSignatureToRaw, isPasskeyAlgorithm } from '../../../src/lib/passkeys/index.ts';
import {
  type Cbor,
  ed25519Authenticator,
  es256Authenticator,
  rawToDer,
  rs256Authenticator,
} from '../../support/passkey-authenticator.ts';

const key = (entries: [number, Cbor][]) => new Map<number | string, Cbor>(entries);

describe('isPasskeyAlgorithm', () => {
  it('should accept exactly ES256, EdDSA and RS256', () => {
    should([-7, -8, -257].every(isPasskeyAlgorithm)).be.true();
    should([-35, -36, -37, -258, 7, '-7', null].some(isPasskeyAlgorithm)).be.false();
  });
});

describe('coseKeyToSpki', () => {
  it('should produce the SPKI the platform itself exports, for all three algorithms', async () => {
    for (const authenticator of [
      await es256Authenticator(),
      await ed25519Authenticator(),
      await rs256Authenticator(),
    ]) {
      // Act
      const result = coseKeyToSpki(authenticator.coseKey);

      // Assert
      should(result).deepEqual({ ok: true, algorithm: authenticator.algorithm, spki: authenticator.spki });
    }
  });

  it('should produce the platform SPKI for a 4096-bit RSA key and a modulus with a leading zero', async () => {
    // Arrange
    const large = await rs256Authenticator(4096);
    const modulus = large.coseKey.get(-1) as Uint8Array;
    const padded = new Map(large.coseKey).set(-1, Uint8Array.from([0, ...modulus]));

    // Act / Assert
    should(coseKeyToSpki(large.coseKey)).deepEqual({ ok: true, algorithm: -257, spki: large.spki });
    should(coseKeyToSpki(padded)).deepEqual({ ok: true, algorithm: -257, spki: large.spki });
  });

  it('should refuse a key whose algorithm is not accepted, or disagrees with its type or curve', async () => {
    // Arrange
    const es = (await es256Authenticator()).coseKey;
    const ed = (await ed25519Authenticator()).coseKey;
    const rs = (await rs256Authenticator()).coseKey;
    const unsupported = [
      new Map(es).set(3, -35),
      new Map([...es].filter(([label]) => label !== 3)),
      new Map(es).set(1, 1),
      new Map(es).set(-1, 2),
      new Map(ed).set(1, 2),
      new Map(ed).set(-1, 4),
      new Map(rs).set(1, 2),
    ];

    // Act / Assert
    for (const cose of unsupported)
      should(coseKeyToSpki(cose)).deepEqual({ ok: false, reason: 'unsupported-algorithm' });
  });

  it('should refuse a key whose coordinates or integers are missing or the wrong size', async () => {
    // Arrange
    const es = (await es256Authenticator()).coseKey;
    const ed = (await ed25519Authenticator()).coseKey;
    const rs = (await rs256Authenticator()).coseKey;
    const modulus = rs.get(-1) as Uint8Array;
    const malformed: Cbor[] = [
      'not a map',
      [1, 2],
      new Map(es).set(-2, new Uint8Array(31)),
      new Map(es).set(-3, 'y'),
      new Map(ed).set(-2, new Uint8Array(33)),
      new Map(rs).set(-1, 'n'),
      new Map(rs).set(-1, new Uint8Array(4)),
      new Map(rs).set(-1, modulus.subarray(0, 255)),
      new Map(rs).set(-1, new Uint8Array(513).fill(1)),
      new Map(rs).set(-2, new Uint8Array(9).fill(1)),
      key([
        [1, 3],
        [3, -257],
        [-1, modulus],
      ]),
    ];

    // Act / Assert
    for (const cose of malformed) should(coseKeyToSpki(cose)).deepEqual({ ok: false, reason: 'malformed' });
  });
});

describe('derSignatureToRaw', () => {
  const raw = (r: number[], s: number[]) => {
    const out = new Uint8Array(64);
    out.set(r, 32 - r.length);
    out.set(s, 64 - s.length);
    return out;
  };

  it('should round-trip a signature whose halves have their top bit set (33-byte DER integers)', () => {
    // Arrange
    const signature = raw(new Array(32).fill(0x80), new Array(32).fill(0xff));

    // Act / Assert
    should(derSignatureToRaw(rawToDer(signature))).deepEqual(signature);
  });

  it('should left-pad a 31-byte integer and one with many leading zeros back to 32 bytes', () => {
    // Arrange — r is 31 bytes; s is a single byte after its zeros were dropped.
    const signature = raw(new Array(31).fill(0x11), [0x05]);

    // Act
    const der = rawToDer(signature);

    // Assert
    should(der[3]).equal(31);
    should(derSignatureToRaw(der)).deepEqual(signature);
  });

  it('should strip redundant leading zeros a lax encoder left in place', () => {
    // Arrange — r carries two zero bytes in front of a 31-byte value.
    const r = [0x02, 33, 0, 0, ...new Array(31).fill(0x22)];
    const s = [0x02, 1, 0x07];
    const der = Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);

    // Act / Assert
    should(derSignatureToRaw(der)).deepEqual(raw(new Array(31).fill(0x22), [0x07]));
  });

  it('should refuse anything that is not exactly SEQUENCE { INTEGER r, INTEGER s } for P-256', () => {
    // Arrange
    const valid = rawToDer(raw([1], [2]));
    const refused: Record<string, Uint8Array> = {
      'not a sequence': Uint8Array.from([0x31, ...valid.subarray(1)]),
      'sequence length disagrees': Uint8Array.from([0x30, (valid[1] ?? 0) + 1, ...valid.subarray(2)]),
      'longer than any P-256 signature': Uint8Array.from([0x30, 72, ...new Array(72).fill(2)]),
      'r is not an integer': Uint8Array.from([0x30, 6, 0x04, 1, 1, 0x02, 1, 2]),
      'r is empty': Uint8Array.from([0x30, 5, 0x02, 0, 0x02, 1, 2]),
      'r is longer than 33 bytes': Uint8Array.from([0x30, 38, 0x02, 34, ...new Array(34).fill(1), 0x02, 0]),
      'r runs past the sequence': Uint8Array.from([0x30, 4, 0x02, 5, 1, 1]),
      'r is negative': Uint8Array.from([0x30, 6, 0x02, 1, 0x80, 0x02, 1, 2]),
      'r is 33 significant bytes': Uint8Array.from([0x30, 38, 0x02, 33, ...new Array(33).fill(1), 0x02, 1, 2]),
      's is missing': Uint8Array.from([0x30, 3, 0x02, 1, 1]),
      'bytes after s': Uint8Array.from([0x30, 8, 0x02, 1, 1, 0x02, 1, 2, 0x00, 0x00]),
    };

    // Act / Assert
    const accepted = Object.entries(refused).filter(([, der]) => derSignatureToRaw(der) !== undefined);
    should(accepted.map(([name]) => name)).deepEqual([]);
  });
});
