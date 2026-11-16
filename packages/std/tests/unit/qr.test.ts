import { describe, expect, it } from 'bun:test';
import { localQr, MAX_QR_VERSION, QrEncodeError } from '../../src/qr.ts';

describe('S14 localQr: the one local encoder', () => {
  it('draws a square symbol with the finder patterns a scanner looks for', () => {
    const { modules, size, version } = localQr('https://ferretry.example.invalid/pair#v1;code=FAKE-CODE');
    expect(modules).toHaveLength(size);
    for (const row of modules) expect(row).toHaveLength(size);
    expect((size - 17) / 4).toBe(version);
    const dark = (row: number, column: number): boolean => modules[row]?.[column] === true;
    for (let index = 0; index < 7; index += 1) {
      expect(dark(0, index)).toBe(true);
      expect(dark(index, 0)).toBe(true);
    }
    expect(dark(1, 1)).toBe(false);
    expect(dark(3, 3)).toBe(true);
  });

  it('uses the smallest version the text fits in', () => {
    expect(localQr('https://f.invalid/x').version).toBeLessThan(
      localQr(`https://f.invalid/${'x'.repeat(300)}`).version,
    );
  });

  it('refuses an empty value', () => {
    expect(() => localQr('')).toThrow(QrEncodeError);
  });

  it('refuses a non-string with a TypeError, never an empty symbol and never a QrEncodeError', () => {
    // `undefined` used to encode as zero bytes and come back as a blank symbol.
    const refuse = (value: unknown): unknown => {
      try {
        localQr(value as string);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    for (const value of [undefined, null, 42, {}, ['x']]) {
      const error = refuse(value);
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(QrEncodeError);
      expect((error as TypeError).message).toBe('a QR symbol encodes text');
    }
  });

  it('refuses rather than truncates a value no symbol can hold', () => {
    expect(() => localQr('x'.repeat(5000))).toThrow('refusing rather than truncating');
  });

  it('refuses a symbol too dense for a phone camera to read reliably', () => {
    expect(MAX_QR_VERSION).toBe(20);
    expect(() => localQr('x'.repeat(1200))).toThrow('a phone can scan');
  });
});
