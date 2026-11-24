import { describe, it } from 'bun:test';
import should from 'should';
import {
  bareMediaName,
  MAX_MEDIA_BYTES,
  MEDIA_CHUNK_BYTES,
  MEDIA_TYPES,
  mediaTypeOf,
  parseMediaRange,
} from '../../../contract/media-bytes.ts';

/** The media byte route's pure rules: which names it serves, as what, and which bytes a `Range` asks for. */

describe('bareMediaName', () => {
  it.each(['clip.mp4', 'a b.mp3', 'Song (final).wav', '.hidden.png'])('should accept the bare name %s', name => {
    should(bareMediaName(name)).eql(name);
  });

  it.each(['', '.', '..', 'a/b.mp4', '../clip.mp4', '/etc/passwd', 'a\\b.mp4', 'a\0b.mp4', 'x/..'])(
    'should refuse %j: it is not one bare file name',
    name => {
      should(bareMediaName(name)).be.undefined();
    },
  );

  it('should refuse a missing name and one past 255 characters', () => {
    should(bareMediaName(undefined)).be.undefined();
    should(bareMediaName(`${'a'.repeat(252)}.mp4`)).be.undefined();
  });
});

describe('mediaTypeOf', () => {
  it('should name a type for every extension on the allowlist, case-insensitively', () => {
    for (const [extension, type] of Object.entries(MEDIA_TYPES)) {
      should(mediaTypeOf(`file.${extension}`)).eql(type);
      should(mediaTypeOf(`FILE.${extension.toUpperCase()}`)).eql(type);
    }
  });

  it.each(['page.html', 'x.svg', 'x.js', 'x.json', 'x.xml', 'x.txt', 'noextension', 'x.', '.mp4', 'x.mp4.exe'])(
    'should serve %s as nothing: it is not on the allowlist',
    name => {
      should(mediaTypeOf(name)).be.undefined();
    },
  );

  it('should never put a page, a script or an image that can run on the allowlist', () => {
    const types = Object.values(MEDIA_TYPES);
    for (const type of types) should(type).match(/^(image|audio|video)\/|^application\/pdf$/u);
    should(types).not.containEql('image/svg+xml');
    should(types).not.containEql('text/html');
  });
});

describe('parseMediaRange', () => {
  const size = 10_000_000;

  it('should read an explicit range as inclusive positions', () => {
    should(parseMediaRange('bytes=0-99', size)).eql({ end: 99, kind: 'part', start: 0 });
    should(parseMediaRange('bytes=100-100', size)).eql({ end: 100, kind: 'part', start: 100 });
  });

  it('should read an open range to the end of the file, clamped to one piece', () => {
    should(parseMediaRange('bytes=9999990-', size)).eql({ end: size - 1, kind: 'part', start: 9_999_990 });
    should(parseMediaRange('bytes=0-', size)).eql({ end: MEDIA_CHUNK_BYTES - 1, kind: 'part', start: 0 });
  });

  it('should clamp an explicit range past the end of the file to the file, and one past a piece to a piece', () => {
    should(parseMediaRange('bytes=9999000-99999999', size)).eql({ end: size - 1, kind: 'part', start: 9_999_000 });
    should(parseMediaRange(`bytes=5-${MEDIA_CHUNK_BYTES * 3}`, size)).eql({
      end: 5 + MEDIA_CHUNK_BYTES - 1,
      kind: 'part',
      start: 5,
    });
  });

  it('should read a suffix range as the last bytes, and a suffix longer than the file as the whole file', () => {
    should(parseMediaRange('bytes=-500', size)).eql({ end: size - 1, kind: 'part', start: size - 500 });
    should(parseMediaRange('bytes=-99999999', 1000)).eql({ end: 999, kind: 'part', start: 0 });
  });

  it('should refuse as unsatisfiable a start at or past the end, a zero suffix and any range of an empty file', () => {
    should(parseMediaRange(`bytes=${size}-`, size)).eql({ kind: 'unsatisfiable' });
    should(parseMediaRange(`bytes=${size + 5}-${size + 9}`, size)).eql({ kind: 'unsatisfiable' });
    should(parseMediaRange('bytes=-0', size)).eql({ kind: 'unsatisfiable' });
    should(parseMediaRange('bytes=0-0', 0)).eql({ kind: 'unsatisfiable' });
    should(parseMediaRange('bytes=-5', 0)).eql({ kind: 'unsatisfiable' });
  });

  it.each([
    undefined,
    '',
    'bytes=',
    'bytes=-',
    'bytes=abc-def',
    'bytes=5-2',
    'items=0-9',
    'bytes=0-9,20-29',
    'bytes=0-9, 20-29',
    'bytes 0-9',
    'bytes=0-9-',
    'bytes=-5-',
    'bytes=99999999999999999999-',
  ])('should ignore the range header %j and answer the whole file', header => {
    should(parseMediaRange(header, size)).eql({ kind: 'whole' });
  });

  it('should keep the cap the client mirrors: 32 MiB in pieces of 4 MiB', () => {
    should(MAX_MEDIA_BYTES).eql(32 * 1024 * 1024);
    should(MEDIA_CHUNK_BYTES).eql(4 * 1024 * 1024);
  });
});
