import { describe, it } from 'bun:test';
import should from 'should';
import {
  generateXCookie,
  X_AUTH_PROTOCOL,
  X_COOKIE_BYTES,
  xauthorityEntry,
  xvfbLaunchArguments,
} from '../../../../src/lib/index.ts';

describe('X authority', () => {
  it('should draw a 16-byte cookie from the entropy it is given', () => {
    // Arrange
    const entropy = (buffer: Uint8Array) => buffer.fill(7);

    // Act
    const cookie = generateXCookie(entropy);

    // Assert
    should(cookie).have.length(X_COOKIE_BYTES);
    should(Array.from(cookie)).deepEqual(Array(16).fill(7));
  });

  it('should encode a FamilyWild MIT-MAGIC-COOKIE-1 entry for the display number', () => {
    // Arrange
    const cookie = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

    // Act
    const entry = xauthorityEntry('123', cookie);

    // Assert
    // family (raw, big-endian), then four fields each as a 2-byte big-endian length and its bytes.
    should(Array.from(entry)).deepEqual([
      0xff,
      0xff,
      0x00,
      0x00,
      0x00,
      0x03,
      0x31,
      0x32,
      0x33,
      0x00,
      0x12,
      ...new TextEncoder().encode(X_AUTH_PROTOCOL),
      0x00,
      0x10,
      ...cookie,
    ]);
  });

  it('should start Xvfb with -auth naming the cookie file, and still refuse TCP', () => {
    // Act
    const argv = xvfbLaunchArguments('/usr/bin/Xvfb', { width: 800, height: 600 }, '/state/x11/xauthority-1');

    // Assert
    should(argv).deepEqual([
      '/usr/bin/Xvfb',
      '-displayfd',
      '1',
      '-screen',
      '0',
      '800x600x24',
      '-nolisten',
      'tcp',
      '-auth',
      '/state/x11/xauthority-1',
    ]);
  });
});
