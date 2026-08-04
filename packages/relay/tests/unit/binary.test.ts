import { describe, it } from 'bun:test';
import {
  bytesEqual,
  concatBytes,
  fromBase64Url,
  fromBase64UrlFixed,
  isAllZero,
  lengthPrefixed,
  readUint32,
  readUint64,
  toBase64Url,
  utf8Bytes,
  utf8Text,
  writeUint32,
  writeUint64,
} from '@ferretry/relay';
import should from 'should';

describe('relay byte helpers', () => {
  it('should round-trip every byte value through unpadded base64url', () => {
    const all = new Uint8Array(256).map((_, index) => index);
    const encoded = toBase64Url(all);
    should(encoded).not.match(/[+/=]/u);
    should(fromBase64Url(encoded)).deepEqual(all);
    should(toBase64Url(new Uint8Array(0))).equal('');
    should(fromBase64Url('')).deepEqual(new Uint8Array(0));
  });

  it('should refuse spellings a lenient decoder would accept', () => {
    should(fromBase64Url('AA==')).be.null();
    should(fromBase64Url('A A')).be.null();
    should(fromBase64Url('AAAA')).deepEqual(new Uint8Array([0, 0, 0]));
    should(fromBase64Url('A')).be.null();
    should(fromBase64Url('AAAAA')).be.null();
    should(fromBase64Url('++//')).be.null();
    should(fromBase64Url('AB')).be.null();
  });

  it('should enforce an exact decoded length where the protocol fixes one', () => {
    const key = new Uint8Array(32).fill(7);
    should(fromBase64UrlFixed(toBase64Url(key), 32)).deepEqual(key);
    should(fromBase64UrlFixed(toBase64Url(key), 31)).be.null();
    should(fromBase64UrlFixed('!!!', 32)).be.null();
  });

  it('should length-prefix transcript fields so a boundary cannot move', () => {
    const joined = concatBytes([lengthPrefixed(utf8Bytes('ab')), lengthPrefixed(utf8Bytes('c'))]);
    const shifted = concatBytes([lengthPrefixed(utf8Bytes('a')), lengthPrefixed(utf8Bytes('bc'))]);
    should(bytesEqual(joined, shifted)).be.false();
    should(readUint32(joined, 0)).equal(2);
    should(concatBytes([])).deepEqual(new Uint8Array(0));
  });

  it('should read and write the fixed-width integers the header uses', () => {
    const target = new Uint8Array(12);
    writeUint32(target, 0, 0xdeadbeef);
    writeUint64(target, 4, Number.MAX_SAFE_INTEGER);
    should(readUint32(target, 0)).equal(0xdeadbeef);
    should(readUint64(target, 4)).equal(Number.MAX_SAFE_INTEGER);
  });

  it('should refuse a 64-bit field it cannot represent exactly', () => {
    const target = new Uint8Array(8).fill(0xff);
    should(readUint64(target, 0)).be.null();
  });

  it('should decode valid UTF-8 and refuse the rest', () => {
    should(utf8Text(utf8Bytes('ferretry ✓'))).equal('ferretry ✓');
    should(utf8Text(new Uint8Array([0xff, 0xfe]))).be.null();
  });

  it('should compare bytes without an early exit, and recognise a zero secret', () => {
    should(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).be.true();
    should(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).be.false();
    should(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).be.false();
    should(isAllZero(new Uint8Array(4))).be.true();
    should(isAllZero(new Uint8Array([0, 0, 1]))).be.false();
  });
});
