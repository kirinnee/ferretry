import { describe, expect, it } from 'bun:test';
import { redactText } from '../../../src/lib/fleet/catalog.ts';
import { referenceRedactEncoded } from '../../support/redact-encoded-r3.ts';
import { MATRIX_SHAPES, MATRIX_WRAPPERS, matrixExposure } from '../../support/redact-encoded-matrix.ts';
import {
  ENCODED_SHAPES,
  ENCODED_WRAPPERS,
  IMAGE_KEY_WRAPPERS,
  IMAGE_PREFIXES,
  encodedSample,
  exposedEncoded,
} from '../../support/redact-encoded-samples.ts';

describe('whole-word encoded scanning before additional path masking', () => {
  it('masks an encoded path segment when public folders dilute the whole-word entropy', () => {
    const folder = 'a'.repeat(128);
    const value = 'aB3dE5gH7jK9mN2pQ4sT6vW8yZ0cF1hL5';
    expect(redactText(`/${folder}/${value}/docs/file.txt`)).toEqual({
      text: `/${folder}/‹hidden›/docs/file.txt`,
      redacted: true,
    });
  });
  it.each(ENCODED_WRAPPERS)('preserves adjacent punctuation in %s for 10,000 keys', (_name, wrap) => {
    const failures: number[] = [];
    for (let sample = 0; sample < 10_000; sample++)
      if (redactText(wrap(encodedSample(sample, 32))).text !== wrap('‹hidden›')) failures.push(sample);
    expect(failures).toEqual([]);
  });
  for (const prefix of IMAGE_PREFIXES) {
    it(`masks image-like ${prefix} keys and padded ciphertext inside data URIs`, () => {
      for (const length of [32, 64, 148, 616]) {
        for (let sample = 0; sample < 64; sample++) {
          const value = prefix + encodedSample(sample, length).slice(prefix.length);
          expect(redactText(`data:image/png;base64,${value}`).text).toBe('data:image/png;base64,‹hidden›');
          expect(redactText(value).text).toBe('‹hidden›');
        }
      }
    });
    for (const [wrapper, wrap] of IMAGE_KEY_WRAPPERS) {
      it(`masks canonical image-like keys with ${prefix} in ${wrapper}, preserving punctuation`, () => {
        const failures: number[] = [];
        for (let sample = 0; sample < 64; sample++) {
          const key = prefix + encodedSample(sample, 32).slice(prefix.length);
          const expected = wrap('‹hidden›');
          if (redactText(wrap(key)).text !== expected) failures.push(sample);
        }
        expect(failures).toEqual([]);
      });
    }
  }
  it('masks an exact vault key used as an image payload', () => {
    expect(redactText(`data:image/png;base64,${encodedSample(0, 32)}`).text).toBe('data:image/png;base64,‹hidden›');
  });
  it.each([
    ['png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='],
    ['gif', 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'],
    // small/webp.webp's VP8L image with a standard ignorable RIFF JUNK chunk.
    ['webp', 'UklGRioAAABXRUJQVlA4TAYAAAAvQWxvAGtKVU5LEAAAAAAAAAAAAAAAAAAAAAAAAAA='],
    // Public 1x1 JPEG fixture: https://github.com/mathiasbynens/small/blob/master/jpeg.jpg
    [
      'jpeg',
      '/9j/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=',
    ],
  ])('keeps a complete %s image as bytes, data URI and Markdown', (type, payload) => {
    for (const bytes of [payload, payload.replace(/=+$/u, '')])
      for (const text of [bytes, `data:image/${type};base64,${bytes}`, `![pixel](data:image/${type};base64,${bytes})`])
        expect(redactText(text)).toEqual({ text, redacted: false });
    if (payload.endsWith('='))
      expect(redactText(`data:image/${type === 'jpeg' ? 'png' : 'jpeg'};base64,${payload}`).text).not.toContain(
        payload,
      );
  });
  it('masks low-entropy padded ciphertext even when an adjacent prefix shifts its base64 alignment', () => {
    const value = `${'Ab1'.repeat(27)}AA==`;
    for (const prefix of ['a', 'x+', '$X/9', 'notes-9'])
      expect(redactText(`${prefix}${value}.md`).text).not.toContain(value);
  });
  it('masks complete padded ciphertext before a key-shaped suffix can split it', () => {
    const value = `${'A'.repeat(43)}/${encodedSample(0, 32)}`;
    expect(redactText(value).text).toBe('‹hidden›');
  });
  it('never revives low-entropy fragments after masking a key-shaped span', () => {
    for (let sample = 0; sample < 100; sample++) {
      const value = `${'Ab1'.repeat(11)}/${encodedSample(sample, 32)}`;
      const reference = referenceRedactEncoded(value, () => {});
      expect(exposedEncoded(redactText(value).text, value)).toBeLessThanOrEqual(exposedEncoded(reference, value));
    }
  });
  for (const [shape, length] of ENCODED_SHAPES) {
    for (const [wrapper, wrap] of ENCODED_WRAPPERS) {
      it(`${shape} with '/' in ${wrapper} never exposes more than 5e4f86 per sample`, () => {
        const failures: number[] = [];
        let checked = 0;
        const count = length === 32 ? 10_000 : 1_000;
        for (let sample = 0; checked < count; sample++) {
          const value = encodedSample(sample, length);
          if (!value.includes('/')) continue;
          checked++;
          const input = wrap(value);
          const current = redactText(input).text;
          const reference = referenceRedactEncoded(input, () => {});
          if (
            exposedEncoded(current, value) > exposedEncoded(reference, value) ||
            (length === 32 && current.includes(value))
          )
            failures.push(sample);
        }
        expect(failures).toEqual([]);
      });
    }
  }
});

describe('all encoded shapes through every path and image wrapper', () => {
  for (const [shape, sampleValue] of MATRIX_SHAPES) {
    for (const [wrapper, wrap] of MATRIX_WRAPPERS) {
      it(`${shape} in ${wrapper} never exposes more than 5e4f86`, () => {
        const failures: number[] = [];
        for (let sample = 0; sample < 256; sample++) {
          const input = wrap(sampleValue(sample));
          const exposed = matrixExposure(redactText(input).text, input);
          const baseline = matrixExposure(
            referenceRedactEncoded(input, () => {}),
            input,
          );
          if (exposed > baseline || (shape === 'vault' && exposed > 0)) failures.push(sample);
        }
        expect(failures).toEqual([]);
      });
    }
  }
});
