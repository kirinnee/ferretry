import { describe, it } from 'bun:test';
import should from 'should';
import { inspectImageBase64, sniffImageType } from '../../../src/lib/transcript/image-bytes.ts';
import { gifBase64, jpegBase64, pngBase64, pngBytes, webpBase64 } from '../../support/transcript-images.ts';

describe('sniffImageType', () => {
  it.each([
    ['a PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
    ['a PNG whose signature is cut short', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x00], undefined],
    ['a JPEG', [0xff, 0xd8, 0xff, 0xe0], 'image/jpeg'],
    ['a GIF89a', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'image/gif'],
    ['a GIF87a', [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], 'image/gif'],
    ['a GIF with a bad version', [0x47, 0x49, 0x46, 0x38, 0x39, 0x62], undefined],
    ['plain text', [0x68, 0x74, 0x6d, 0x6c], undefined],
    ['nothing', [], undefined],
  ])('should read %s', (_name, bytes, expected) => {
    // Act
    const actual = sniffImageType(Uint8Array.from(bytes));

    // Assert
    should(actual).equal(expected);
  });

  it('should read a WebP and refuse a RIFF that is not one', () => {
    // Arrange
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
    const wave = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);

    // Act / Assert
    should(sniffImageType(webp)).equal('image/webp');
    should(sniffImageType(wave)).equal(undefined);
  });
});

describe('inspectImageBase64', () => {
  it.each([
    ['PNG', pngBase64(), 'image/png', 32],
    ['JPEG', jpegBase64(), 'image/jpeg', 28],
    ['GIF', gifBase64(), 'image/gif', 14],
    ['WebP', webpBase64(), 'image/webp', 40],
  ])('should prove a %s and size it from its base64', async (_name, base64, mediaType, byteLength) => {
    // Act
    const actual = await inspectImageBase64(base64);

    // Assert
    should(actual).eql({ mediaType, byteLength, base64 });
  });

  it('should accept bytes as well as a string', async () => {
    // Act
    const actual = await inspectImageBase64(Buffer.from(pngBase64()));

    // Assert
    should(actual?.mediaType).equal('image/png');
  });

  it('should answer the standard padded alphabet for a URL-safe, unpadded spelling', async () => {
    // Arrange
    const raw = Buffer.concat([pngBytes(0), Buffer.from([0xfb, 0xff, 0xfe, 0xfb, 0xff, 0xfe, 0xfb, 0xff, 0xfe])]);
    const standard = raw.toString('base64');
    const urlSafe = raw.toString('base64url');
    should(urlSafe).not.equal(standard);

    // Act
    const actual = await inspectImageBase64(urlSafe);

    // Assert
    should(actual?.base64).equal(standard);
    should(actual?.byteLength).equal(raw.byteLength);
  });

  it('should pad an unpadded spelling', async () => {
    // Arrange
    const raw = pngBytes(5);
    const unpadded = raw.toString('base64').replace(/=+$/u, '');

    // Act
    const actual = await inspectImageBase64(unpadded);

    // Assert
    should(actual?.base64).equal(raw.toString('base64'));
    should(actual?.byteLength).equal(raw.byteLength);
  });

  it('should check a payload larger than one slice, in slices', async () => {
    // Arrange
    const big = pngBase64(2 * 1024 * 1024);
    const bigUrlSafe = pngBytes(2 * 1024 * 1024).toString('base64url');

    // Act
    const actual = await inspectImageBase64(big);
    const urlSafe = await inspectImageBase64(bigUrlSafe);
    const bad = await inspectImageBase64(`${big.slice(0, 1_500_000)}!${big.slice(1_500_001)}`);

    // Assert
    should(actual?.byteLength).equal(2 * 1024 * 1024 + 8);
    should(urlSafe?.base64).equal(big);
    should(bad).equal(undefined);
  });

  it.each([
    ['text that is not base64', 'hello world, this is not an image at all'],
    ['base64 of text', Buffer.from('<html><body>not an image</body></html>').toString('base64')],
    ['an embedded newline', `${pngBase64().slice(0, 12)}\n${pngBase64().slice(12)}`],
    ['an embedded space', `${pngBase64().slice(0, 12)} ${pngBase64().slice(12)}`],
    ['padding in the middle', `${pngBase64().slice(0, 12)}=${pngBase64().slice(13)}`],
    ['three padding characters', `${pngBase64().replace(/=+$/u, '')}===`],
    ['padding that does not make a whole quantum', `${pngBase64().replace(/=+$/u, '')}==`],
    ['a length no base64 has', `${pngBase64().replace(/=+$/u, '')}A`.padEnd(41, 'A').slice(0, 41)],
    ['too few characters to tell', 'iVBORw0K'],
    ['non-ASCII text', `${pngBase64()}é`],
    ['nothing', ''],
  ])('should refuse %s', async (_name, source) => {
    // Act
    const actual = await inspectImageBase64(source);

    // Assert
    should(actual).equal(undefined);
  });
});
