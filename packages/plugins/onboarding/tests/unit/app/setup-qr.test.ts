import { describe, expect, it } from 'bun:test';
import { qrModules } from '../../../app/setup-qr.ts';

describe('the QR modules', () => {
  it('are a square grid with the finder patterns a scanner looks for', () => {
    const modules = qrModules('https://ferretry.example.invalid/setup#fy-setup=f1;route=add-client;step=pair');

    // Square, and a real QR version rather than an empty grid.
    expect(modules.length).toBeGreaterThan(20);
    for (const row of modules) expect(row).toHaveLength(modules.length);

    // The top-left finder pattern: 7×7, a solid ring around a 3×3 core. If this
    // holds, the encoder ran — a hand-rolled grid of noise would not have it.
    const dark = (row: number, column: number): boolean => modules[row]?.[column] === true;
    for (let index = 0; index < 7; index += 1) {
      expect(dark(0, index)).toBe(true);
      expect(dark(6, index)).toBe(true);
      expect(dark(index, 0)).toBe(true);
      expect(dark(index, 6)).toBe(true);
    }
    expect(dark(1, 1)).toBe(false);
    expect(dark(3, 3)).toBe(true);
  });

  it('stays small for a short link and grows for a long one', () => {
    // Version 0 asks the encoder for the smallest version the text fits in, so a
    // short link stays a coarse QR a cheap camera can read.
    const short = qrModules('https://f.invalid/setup');
    const long = qrModules(`https://f.invalid/setup#fy-setup=${'x'.repeat(400)}`);
    expect(long.length).toBeGreaterThan(short.length);
  });
});
