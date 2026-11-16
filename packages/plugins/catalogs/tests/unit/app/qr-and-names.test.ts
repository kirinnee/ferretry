import { describe, expect, it } from 'bun:test';
import { memberClientName } from '../../../app/lib/members.ts';
import { encodeQr, MAX_QR_VERSION, QrEncodeError } from '../../../app/lib/qr.ts';

describe('N3 the share QR stays scannable', () => {
  it('draws a short link and refuses one that needs a symbol past version 20', () => {
    expect(encodeQr('https://box.example.test/join#v1').version).toBeLessThanOrEqual(MAX_QR_VERSION);
    expect(() => encodeQr('a'.repeat(900))).toThrow(QrEncodeError);
  });
});

describe('N4 a member device is told apart on the People list', () => {
  it('names the browser with a random suffix', () => {
    expect(memberClientName(() => Uint8Array.of(0xab, 0x01))).toBe('Browser ab01');
    expect(memberClientName(() => Uint8Array.of(0, 0))).not.toBe(memberClientName(() => Uint8Array.of(0, 1)));
  });
});
