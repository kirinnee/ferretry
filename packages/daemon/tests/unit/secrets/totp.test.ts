import { describe, it } from 'bun:test';
import should from 'should';
import { base32Bytes, hotp, totpCode } from '../../../src/lib/secrets/totp.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 of ASCII, so the RFC's ASCII seeds can be written as an authenticator shows them. */
function base32(ascii: string): string {
  let bits = '';
  for (const byte of new TextEncoder().encode(ascii)) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let index = 0; index < bits.length; index += 5) out += ALPHABET[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  return out;
}

const SEEDS = {
  SHA1: base32('12345678901234567890'),
  SHA256: base32('12345678901234567890123456789012'),
  SHA512: base32('1234567890123456789012345678901234567890123456789012345678901234'),
} as const;

/** RFC 6238 Appendix B: time in seconds, then the 8-digit code for SHA1, SHA256 and SHA512. */
const VECTORS: readonly (readonly [number, string, string, string])[] = [
  [59, '94287082', '46119246', '90693936'],
  [1_111_111_109, '07081804', '68084774', '25091201'],
  [1_111_111_111, '14050471', '67062674', '99943326'],
  [1_234_567_890, '89005924', '91819424', '93441116'],
  [2_000_000_000, '69279037', '90698825', '38618901'],
  [20_000_000_000, '65353130', '77737706', '47863826'],
];

describe('a 2FA code from a saved seed', () => {
  for (const [seconds, sha1, sha256, sha512] of VECTORS) {
    it(`should match the RFC 6238 vectors at ${seconds}s`, () => {
      const at = seconds * 1000;
      should(totpCode(SEEDS.SHA1, { algorithm: 'SHA1', digits: 8, period: 30 }, at)).equal(sha1);
      should(totpCode(SEEDS.SHA256, { algorithm: 'SHA256', digits: 8, period: 30 }, at)).equal(sha256);
      should(totpCode(SEEDS.SHA512, { algorithm: 'SHA512', digits: 8, period: 30 }, at)).equal(sha512);
    });
  }

  it('should match RFC 4226 HOTP for the first counters, six digits', () => {
    const key = base32Bytes(SEEDS.SHA1) as Uint8Array;
    should([0, 1, 2, 3, 9].map(counter => hotp(key, counter, 6, 'SHA1'))).deepEqual([
      '755224',
      '287082',
      '359152',
      '969429',
      '520489',
    ]);
  });

  it('should make the six-digit code most authenticators show, the same through one period', () => {
    const parameters = { algorithm: 'SHA1', digits: 6, period: 30 } as const;
    should(totpCode(SEEDS.SHA1, parameters, 59_000)).equal('287082');
    should(totpCode(SEEDS.SHA1, parameters, 30_000)).equal(totpCode(SEEDS.SHA1, parameters, 59_999));
    should(totpCode(SEEDS.SHA1, parameters, 60_000)).not.equal(totpCode(SEEDS.SHA1, parameters, 59_999));
  });

  it('should read a seed written with spaces, dashes, padding or lower case', () => {
    should(base32Bytes('gezd gnbv-gy3t qojq====')).deepEqual(base32Bytes('GEZDGNBVGY3TQOJQ'));
  });

  it('should refuse a seed that is not base32', () => {
    should(base32Bytes('not base32 1!')).be.undefined();
    should(base32Bytes('')).be.undefined();
    should(totpCode('0189', { algorithm: 'SHA1', digits: 6, period: 30 }, 0)).be.undefined();
  });
});
