import { describe, expect, it } from 'bun:test';
import { localQr, MAX_QR_VERSION, QrEncodeError } from '../../../src/ui/local-qr.ts';

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

  it('refuses rather than truncates a value no symbol can hold', () => {
    expect(() => localQr('x'.repeat(5000))).toThrow('refusing rather than truncating');
  });

  it('refuses a symbol too dense for a phone camera to read reliably', () => {
    expect(MAX_QR_VERSION).toBe(20);
    expect(() => localQr('x'.repeat(1200))).toThrow('a phone can scan');
  });
});
