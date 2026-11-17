import { describe, expect, it } from 'bun:test';
import { browserDeviceName } from '@ferretry/app';
import { MemberClientNameSchema } from '../../../contract/wire/catalog-member.ts';
import { encodeQr, MAX_QR_VERSION, QrEncodeError } from '../../../app/lib/qr.ts';

describe('N3 the share QR stays scannable', () => {
  it('draws a short link and refuses one that needs a symbol past version 20', () => {
    expect(encodeQr('https://box.example.test/join#v1').version).toBeLessThanOrEqual(MAX_QR_VERSION);
    expect(() => encodeQr('a'.repeat(900))).toThrow(QrEncodeError);
  });
});

describe('N4 a member device is told apart on the People list', () => {
  it('is named as a person would call the browser, with a short suffix, and the publisher accepts that as a label', () => {
    const name = browserDeviceName();
    expect(name).toMatch(/ · [2-9A-HJKMNP-Z]{4}$/u);
    expect(name).not.toMatch(/^Browser [0-9a-f]{4}$/u);
    expect(MemberClientNameSchema.safeParse(name).success).toBe(true);
  });
});
