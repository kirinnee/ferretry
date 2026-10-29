import { describe, it } from 'bun:test';
import should from 'should';
import * as images from '../../src/lib/transcript-images.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const handle = { recordOffset: 4_096, recordLength: 3_145_728, ordinal: 0 };

const accepted: SchemaCase[] = [
  {
    name: 'a png read back from the transcript',
    schema: images.TranscriptImageDownloadSchema,
    value: { image: { handle: '4096.3145728.0', mediaType: 'image/png', byteLength: 3 }, base64: 'iVBO' },
  },
];

describe('transcript image handles', () => {
  it('should round-trip a handle through its spelling', () => {
    const spelled = images.formatTranscriptImageHandle(handle);
    should(spelled).equal('4096.3145728.0');
    should(images.parseTranscriptImageHandle(spelled)).deepEqual(handle);
  });

  it('should refuse every spelling that is not exactly one handle', () => {
    for (const text of [
      '',
      '4096.3145728',
      '4096.3145728.0.1',
      '04096.10.0',
      '1.0.0',
      '1.10.-1',
      '1.10.256',
      `1.${String(images.MAX_TRANSCRIPT_IMAGE_RECORD_BYTES + 1)}.0`,
      '1e3.10.0',
      '1.10.0 ',
      '../1.10.0',
    ])
      should(images.parseTranscriptImageHandle(text)).be.undefined();
  });

  it('should build a route path that names the session and the handle', () => {
    should(images.transcriptImagePath('s/1', handle)).equal('/v1/sessions/s%2F1/transcript-images/4096.3145728.0');
  });
});

describe('transcript image markers', () => {
  it('should take well-formed markers out of the text and keep their order', () => {
    const text = `${images.formatTranscriptImageMarker({ handle, mediaType: 'image/png' })}`;
    should(text).equal('[fy-image 4096.3145728.0 image/png]');
    const split = images.splitTranscriptImageMarkers(
      `Took a screenshot\n${text}\n${images.formatTranscriptImageMarker({ handle: { ...handle, ordinal: 1 } })}`,
    );
    should(split.text).equal('Took a screenshot');
    should(split.images).deepEqual([{ handle, mediaType: 'image/png' }, { handle: { ...handle, ordinal: 1 } }]);
  });

  it('should leave the attachment kind in front of its marker', () => {
    const split = images.splitTranscriptImageMarkers('image [fy-image 0.70000.0 image/jpeg]');
    should(split.text).equal('image');
    should(split.images).deepEqual([
      { handle: { recordOffset: 0, recordLength: 70_000, ordinal: 0 }, mediaType: 'image/jpeg' },
    ]);
  });

  it('should leave malformed markers in the text as somebody wrote them', () => {
    for (const text of [
      '[fy-image 1.2 image/png]',
      '[fy-image 1.2.3 image/svg+xml]',
      '[fy-image 01.2.3 -]',
      'no marker',
    ])
      should(images.splitTranscriptImageMarkers(text)).deepEqual({ text, images: [] });
  });
});

describe('TranscriptImageDownloadSchema', () => {
  it('should round-trip a download', () => assertRoundTrips(accepted));

  it('should refuse a type the chat cannot paint and a handle that is not one', () =>
    assertRejects([
      {
        name: 'svg',
        schema: images.TranscriptImageDownloadSchema,
        value: { image: { handle: '1.2.0', mediaType: 'image/svg+xml', byteLength: 3 }, base64: 'PHN2' },
      },
      {
        name: 'bad handle',
        schema: images.TranscriptImageDownloadSchema,
        value: { image: { handle: '1.2', mediaType: 'image/png', byteLength: 3 }, base64: 'iVBO' },
      },
      {
        name: 'extra key',
        schema: images.TranscriptImageDownloadSchema,
        value: { image: { handle: '1.2.0', mediaType: 'image/png', byteLength: 3 }, base64: 'iVBO', data: 'x' },
      },
    ]));

  it('should cover every schema the module exports', () => assertCoversEverySchema(images, accepted));
});
