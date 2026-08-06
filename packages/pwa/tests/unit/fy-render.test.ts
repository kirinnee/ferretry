import { describe, test } from 'bun:test';
import should from 'should';
import {
  FY_RENDER_FENCE_LANGUAGE,
  FY_RENDER_IMAGE_MIMES,
  FY_RENDER_LIMITS,
  FY_RENDER_TYPES,
  type FyRenderParseResult,
  fyRenderPresentation,
  parseFyRender,
} from '../../src/lib/fy-render.ts';

/**
 * The grammar, read as a grammar: every assertion here is about what
 * `parseFyRender` accepts and what it refuses, never about how a block looks.
 *
 * NOTE ON THE FENCE TOKEN. These tests deal in fence BODIES, never in fence
 * openers, and that is deliberate rather than incidental:
 * `scripts/validate/no-fy-render-in-docs.sh` fails any tracked file outside the
 * two teaching documents that contains the opener, and a test file is a tracked
 * file. `markdown.test.tsx` needs real openers and assembles them.
 */

const body = (...lines: readonly string[]): string => lines.join('\n');

const reasonOf = (result: FyRenderParseResult): string => (result.ok ? '<accepted>' : result.reason);

const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

/**
 * REAL CONTAINERS, built byte by byte.
 *
 * The grammar now reads a raster's declared dimensions before anything decodes
 * it, so a fixture has to be a structurally complete file rather than four
 * base64 characters. Building them here — rather than pasting opaque base64 —
 * is what lets a test say "this PNG declares 65535×65535" and be read as that.
 * Cross-checked against Chrome's own encoder: for real PNG, JPEG, WebP and GIF
 * samples at 1×1 through 8192×2048, the parser's dimensions matched
 * `naturalWidth`/`naturalHeight` exactly, 18 of 18.
 */
const bytes = (...values: readonly number[]): Uint8Array => Uint8Array.from(values);
const base64 = (value: Uint8Array): string => Buffer.from(value).toString('base64');
const be32 = (value: number): readonly number[] => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];
const chars = (text: string): readonly number[] => [...text].map(character => character.charCodeAt(0));

/** One `IDAT`. Its bytes are never decompressed here — only its presence and run are read. */
const IDAT: readonly number[] = [...be32(2), ...chars('IDAT'), 0x78, 0x01, 0, 0, 0, 0];
/** A second `IHDR`, which no real PNG carries: the dimension decoy. */
const secondIhdr = (width: number, height: number): readonly number[] => [
  ...be32(13),
  ...chars('IHDR'),
  ...be32(width),
  ...be32(height),
  8,
  6,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
];

/**
 * A complete PNG: signature, a 13-byte IHDR, optional extra chunks, one IDAT,
 * and a zero-length terminal IEND. `data: false` omits the IDAT, which is the
 * header-and-end shell the parser must now refuse.
 */
const png = (width: number, height: number, extra: readonly number[] = [], data = true): Uint8Array =>
  bytes(
    0x89,
    ...chars('PNG\r\n\x1a\n'),
    ...be32(13),
    ...chars('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...extra,
    ...(data ? IDAT : []),
    ...be32(0),
    ...chars('IEND'),
    0,
    0,
    0,
    0,
  );
/** The `acTL` chunk is what makes a PNG an APNG. */
const APNG_CONTROL: readonly number[] = [...be32(8), ...chars('acTL'), ...be32(3), ...be32(0), 0, 0, 0, 0];

/** A complete JPEG: SOI, the given frame headers, SOS, EOI. */
const sof = (width: number, height: number): readonly number[] => [
  0xff,
  0xc0,
  0,
  17,
  8,
  (height >> 8) & 255,
  height & 255,
  (width >> 8) & 255,
  width & 255,
  3,
  1,
  0x22,
  0,
  2,
  0x11,
  1,
  3,
  0x11,
  1,
];
const jpeg = (...frames: readonly (readonly number[])[]): Uint8Array =>
  bytes(0xff, 0xd8, ...frames.flat(), 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0xff, 0xd9);

/** A complete GIF: header, logical screen, `frames` image descriptors, trailer. */
const gif = (width: number, height: number, frames = 1, frameWidth = width, frameHeight = height): Uint8Array =>
  bytes(
    ...chars('GIF89a'),
    width & 255,
    width >> 8,
    height & 255,
    height >> 8,
    0,
    0,
    0,
    ...Array.from({ length: frames }, () => [
      0x2c,
      0,
      0,
      0,
      0,
      frameWidth & 255,
      frameWidth >> 8,
      frameHeight & 255,
      frameHeight >> 8,
      0,
      2,
      2,
      0x44,
      1,
      0,
    ]).flat(),
    0x3b,
  );

/** A complete WebP: a RIFF whose declared size matches, carrying VP8X. */
const webp = (width: number, height: number, animated = false, trailing: readonly number[] = []): Uint8Array => {
  const body_ = [
    ...chars('VP8X'),
    10,
    0,
    0,
    0,
    animated ? 0x02 : 0x00,
    0,
    0,
    0,
    (width - 1) & 255,
    ((width - 1) >> 8) & 255,
    ((width - 1) >> 16) & 255,
    (height - 1) & 255,
    ((height - 1) >> 8) & 255,
    ((height - 1) >> 16) & 255,
    ...trailing,
  ];
  return bytes(...chars('RIFF'), ...be32(0).slice(0, 0), ...leSize(body_.length + 4), ...chars('WEBP'), ...body_);
};
const leSize = (value: number): readonly number[] => [
  value & 255,
  (value >> 8) & 255,
  (value >> 16) & 255,
  (value >> 24) & 255,
];
/** An `ANMF` chunk, which makes a WebP animated even with the VP8X flag clear. */
const WEBP_FRAME: readonly number[] = [...chars('ANMF'), 2, 0, 0, 0, 0, 0];

/** The smallest raster the grammar accepts, used wherever the bytes are incidental. */
const PIXEL = base64(png(1, 1));

describe('fy-render fence language', () => {
  test('should name exactly the token the renderer matches', () => {
    should(FY_RENDER_FENCE_LANGUAGE).equal('fy-render');
  });

  test('should declare the five types the block grammar accepts', () => {
    should([...FY_RENDER_TYPES]).eql(['html', 'svg', 'lottie', 'mermaid', 'image']);
  });

  test('should keep the image MIME allowlist raster-only', () => {
    // Arrange / Assert — an SVG routed through `type: image` would skip every
    // SVG check, so the vector MIME must never be reachable from here.
    should([...FY_RENDER_IMAGE_MIMES]).not.containEql('image/svg+xml');
  });
});

describe('fy-render presentation', () => {
  test('should render only the two static types as a visual in this build', () => {
    // Act
    const presentation = FY_RENDER_TYPES.map(type => [type, fyRenderPresentation(type)]);

    // Assert
    should(presentation).eql([
      ['html', 'source'],
      ['svg', 'visual'],
      ['lottie', 'source'],
      ['mermaid', 'source'],
      ['image', 'visual'],
    ]);
  });
});

describe('fy-render headers', () => {
  test('should accept a minimal well-formed block and keep the body as its source', () => {
    // Arrange
    const source = body('type: mermaid', 'alt: A sequence', '---', 'graph TD;');

    // Act
    const result = parseFyRender(source);

    // Assert
    should(result.ok).be.true();
    should(result).match({ ok: true, block: { type: 'mermaid', alt: 'A sequence', payload: 'graph TD;', source } });
  });

  test('should refuse a body with no boundary line', () => {
    should(reasonOf(parseFyRender(body('type: svg', 'alt: A square')))).containEql('--- boundary line');
  });

  test('should refuse a boundary line with no headers above it', () => {
    should(reasonOf(parseFyRender(body('---', SQUARE)))).equal('Missing fy-render headers');
  });

  test('should refuse a header line that is not exactly key: value', () => {
    should(reasonOf(parseFyRender(body('type = svg', '---', SQUARE)))).containEql('"key: value" form');
  });

  test('should refuse a header key outside the closed set', () => {
    should(reasonOf(parseFyRender(body('type: svg', 'alt: A square', 'width: 40', '---', SQUARE)))).equal(
      'Unknown fy-render header: width',
    );
  });

  test('should refuse a repeated header key', () => {
    should(reasonOf(parseFyRender(body('type: svg', 'alt: one', 'alt: two', '---', SQUARE)))).equal(
      'Duplicate fy-render header: alt',
    );
  });

  test('should refuse a block whose first header line is not type', () => {
    // Arrange / Assert — row 65 declares the type on the FIRST line, so a block
    // that merely contains a type header somewhere is not one.
    should(reasonOf(parseFyRender(body('alt: A square', 'type: svg', '---', SQUARE)))).equal(
      'The first header line must declare type',
    );
  });

  test('should refuse a block with no type header at all', () => {
    should(reasonOf(parseFyRender(body('alt: A square', '---', SQUARE)))).equal(
      'The first header line must declare type',
    );
  });

  test('should refuse a type outside the declared five', () => {
    should(reasonOf(parseFyRender(body('type: webgl', 'alt: A square', '---', SQUARE)))).equal(
      'Unknown fy-render type: webgl',
    );
  });

  test('should refuse a block with no alt, because an inaccessible block is not a degraded render', () => {
    should(reasonOf(parseFyRender(body('type: svg', '---', SQUARE)))).equal('Missing required alt header');
  });

  test('should refuse empty alt text', () => {
    should(reasonOf(parseFyRender(body('type: svg', 'alt: ', '---', SQUARE)))).equal('Alt text must not be empty');
  });

  test('should refuse control characters in alt text', () => {
    should(reasonOf(parseFyRender(body('type: svg', 'alt: a\tb', '---', SQUARE)))).containEql('control characters');
  });

  test('should refuse alt text past the character cap', () => {
    const alt = 'a'.repeat(FY_RENDER_LIMITS.altCharacters + 1);
    should(reasonOf(parseFyRender(body('type: svg', `alt: ${alt}`, '---', SQUARE)))).equal(
      'Alt text exceeds 200 characters',
    );
  });

  test('should accept alt text exactly at the character cap', () => {
    const alt = 'a'.repeat(FY_RENDER_LIMITS.altCharacters);
    should(parseFyRender(body('type: svg', `alt: ${alt}`, '---', SQUARE)).ok).be.true();
  });

  test('should refuse an image block with no mime', () => {
    should(reasonOf(parseFyRender(body('type: image', 'alt: A pixel', '---', PIXEL)))).equal(
      'Image blocks require a mime header',
    );
  });

  test('should refuse a mime header on a non-image block', () => {
    should(reasonOf(parseFyRender(body('type: svg', 'alt: A square', 'mime: image/png', '---', SQUARE)))).equal(
      'The mime header is only valid for image blocks',
    );
  });

  test('should refuse a mime outside the raster allowlist', () => {
    should(reasonOf(parseFyRender(body('type: image', 'alt: A pixel', 'mime: image/svg+xml', '---', PIXEL)))).equal(
      'Unsupported image MIME type: image/svg+xml',
    );
  });
});

describe('fy-render html payloads', () => {
  test('should accept an HTML payload inside the byte cap', () => {
    should(parseFyRender(body('type: html', 'alt: A widget', '---', '<p>hello</p>')).ok).be.true();
  });

  test('should refuse an HTML payload past the byte cap', () => {
    const payload = 'a'.repeat(FY_RENDER_LIMITS.htmlBytes + 1);
    should(reasonOf(parseFyRender(body('type: html', 'alt: A widget', '---', payload)))).equal(
      'HTML payload exceeds 200 KiB',
    );
  });
});

describe('fy-render svg payloads', () => {
  const svg = (payload: string): FyRenderParseResult =>
    parseFyRender(body('type: svg', 'alt: A square', '---', payload));

  test('should accept a plain SVG payload', () => {
    should(svg(SQUARE).ok).be.true();
  });

  test('should accept an SVG behind a declaration, a processing instruction and a comment', () => {
    should(svg(`<?xml version="1.0"?>\n<!-- drawn by hand -->\n${SQUARE}`).ok).be.true();
  });

  test('should refuse an SVG payload past the byte cap', () => {
    should(reasonOf(svg('a'.repeat(FY_RENDER_LIMITS.svgBytes + 1)))).equal('SVG payload exceeds 100 KiB');
  });

  test('should refuse document type and entity declarations', () => {
    should(reasonOf(svg(`<!DOCTYPE svg>${SQUARE}`))).containEql('entity declarations are not accepted');
    should(reasonOf(svg(`<!ENTITY lol "lol">${SQUARE}`))).containEql('entity declarations are not accepted');
  });

  test('should refuse a payload that does not begin with an svg element', () => {
    should(reasonOf(svg('<div><svg/></div>'))).equal('SVG payload must begin with an <svg> element');
  });

  test('should refuse a script element', () => {
    should(reasonOf(svg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).equal(
      'SVG <script> elements are not accepted',
    );
  });

  test('should refuse a foreignObject element', () => {
    should(reasonOf(svg('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>'))).equal(
      'SVG <foreignObject> elements are not accepted',
    );
  });

  test('should refuse a use element rather than detect its cycles', () => {
    should(reasonOf(svg('<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/></svg>'))).equal(
      'SVG <use> elements are not accepted',
    );
  });

  test('should refuse an unpaired UTF-16 surrogate, because the renderer cannot encode one', () => {
    // Arrange — `encodeURIComponent` throws `URIError` on a lone surrogate, and
    // the renderer builds the `data:` URL with it. A payload the grammar accepts
    // must never be able to throw downstream.
    const lone = String.fromCharCode(0xd800);

    // Assert
    should(reasonOf(svg(`<svg xmlns="http://www.w3.org/2000/svg"><title>${lone}</title></svg>`))).equal(
      'SVG payload contains an unpaired UTF-16 surrogate',
    );
  });

  test('should accept a well-formed surrogate pair, which is one ordinary code point', () => {
    // Arrange / Assert — the refusal above must not cost authors emoji.
    should(svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>🎉</title></svg>').ok).be.true();
  });

  test('should never accept an SVG the renderer cannot turn into a data URL', () => {
    // Arrange — the property, stated directly rather than per-case: whatever the
    // grammar admits, `encodeURIComponent` must survive.
    const payloads = [
      SQUARE,
      '<svg xmlns="http://www.w3.org/2000/svg"><title>🎉 ünïcodé</title></svg>',
      `<svg xmlns="http://www.w3.org/2000/svg"><title>${String.fromCharCode(0xd800)}</title></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><title>${String.fromCharCode(0xdfff)}</title></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><title>${String.fromCharCode(0xd83d, 0xde00)}</title></svg>`,
    ];

    // Act / Assert
    for (const payload of payloads) {
      const result = svg(payload);
      if (!result.ok) continue;
      should(() => encodeURIComponent(result.block.payload)).not.throw();
    }
  });

  test('should refuse a payload past the element cap', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(FY_RENDER_LIMITS.svgElements)}</svg>`;
    should(reasonOf(svg(payload))).equal('SVG payload exceeds 500 elements');
  });

  test('should accept a payload exactly at the element cap', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${'<g/>'.repeat(FY_RENDER_LIMITS.svgElements - 2)}</svg>`;
    should(svg(payload).ok).be.true();
  });

  test('should not treat the word allow-same-origin in a payload as anything at all', () => {
    // Arrange — a payload naming a sandbox token is ordinary text to this
    // grammar, because this build has no frame for a token to affect.
    const payload =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>allow-same-origin</title></svg>';

    // Act
    const result = parseFyRender(body('type: svg', 'alt: A label', '---', payload));

    // Assert
    should(result).match({ ok: true, block: { payload } });
  });
});

/**
 * THE ELEMENT CAP AND THE DECLARED CANVAS.
 *
 * The first build scanned `/<[A-Za-z]/`, so `<_/>`, `<:a/>` and `<À/>` were all
 * invisible to a cap that claimed to count element opening tags — about 25,000
 * of them fitted inside the byte cap. These are the cases that keep the
 * documented fact true, and the ones that keep a decoy from deciding a bound.
 */
describe('fy-render svg structural bounds', () => {
  const svg = (attributes: string, body_ = ''): FyRenderParseResult =>
    parseFyRender(
      body('type: svg', 'alt: x', '---', `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body_}</svg>`),
    );
  const sized = (body_: string): FyRenderParseResult => svg('width="10" height="10"', body_);

  test('should count every XML NameStartChar class, not just ASCII letters', () => {
    for (const tag of ['<_/>', '<:a/>', '<À/>', '<_a/>', '<g/>']) {
      should(reasonOf(sized(tag.repeat(FY_RENDER_LIMITS.svgElements + 1)))).equal('SVG payload exceeds 500 elements');
      should(sized(tag.repeat(FY_RENDER_LIMITS.svgElements - 1)).ok).be.true();
    }
  });

  test('should not count tag-like text that is not a tag', () => {
    // Assert — a regex would read all three of these as 600 elements, and the
    // documented fact is "element opening tags".
    should(sized(`<!-- ${'<g/>'.repeat(600)} -->`).ok).be.true();
    should(sized(`<![CDATA[${'<g/>'.repeat(600)}]]>`).ok).be.true();
    should(sized('</g>'.repeat(600)).ok).be.true();
  });

  test('should refuse a document whose comment, CDATA or tag never closes', () => {
    should(reasonOf(sized('<!-- never closes'))).containEql('unterminated');
    should(reasonOf(sized('<![CDATA[ never closes'))).containEql('unterminated');
    // A tag has to run off the END of the document to be unterminated: inside
    // the wrapper above, the closing `</svg>` would supply the `>`.
    should(reasonOf(parseFyRender(body('type: svg', 'alt: x', '---', '<svg width="10" height="10"><g ')))).containEql(
      'unterminated',
    );
  });

  test('should cap filter primitives, counting a namespace prefix by local name', () => {
    for (const tag of ['<feGaussianBlur/>', '<svg:feGaussianBlur/>']) {
      should(reasonOf(sized(tag.repeat(FY_RENDER_LIMITS.svgFilterPrimitives + 1)))).equal(
        'SVG payload exceeds 32 filter primitives',
      );
      should(sized(tag.repeat(FY_RENDER_LIMITS.svgFilterPrimitives)).ok).be.true();
    }
  });

  test('should read the real width, not a decoy attribute that merely ends in one', () => {
    // Assert — a word-boundary match reads `data-width` and `x:width` as
    // `width`, so a small decoy first would decide the bound for an oversized
    // real dimension after it.
    should(reasonOf(svg('data-width="10" width="999999" height="10"'))).containEql('SVG canvas exceeds');
    should(reasonOf(svg('x:width="10" width="999999" height="10"'))).containEql('SVG canvas exceeds');
    should(svg('data-width="999999" width="10" height="10"').ok).be.true();
  });

  test('should not let a quoted angle bracket hide the attributes after it', () => {
    // Assert — `[^>]*` stops at the `>` inside the title and never sees `width`.
    should(reasonOf(svg('title="a > b" width="999999" height="10"'))).containEql('SVG canvas exceeds');
  });

  test('should bound each axis independently when the units differ', () => {
    // Assert — an earlier draft accepted the pair as soon as it saw a valid
    // percentage, so the oversized px axis rode in on the axis that was fine.
    should(reasonOf(svg('width="100%" height="999999px" viewBox="0 0 10 10"'))).containEql('SVG canvas exceeds');
    should(reasonOf(svg('width="999999px" height="100%" viewBox="0 0 10 10"'))).containEql('SVG canvas exceeds');
    should(svg('width="100%" height="100%" viewBox="0 0 120 60"').ok).be.true();
  });

  test('should hold the canvas at its exact boundaries', () => {
    should(svg('width="8192" height="2048"').ok).be.true();
    should(svg('width="4096" height="4096"').ok).be.true();
    should(reasonOf(svg('width="8193" height="1"'))).containEql('SVG canvas exceeds');
    should(reasonOf(svg('width="4096" height="4097"'))).containEql('SVG canvas exceeds');
    should(reasonOf(svg('viewBox="0 0 100000 100000"'))).containEql('SVG viewBox exceeds');
  });

  test('should refuse a unit it cannot resolve rather than guess at it', () => {
    for (const unit of ['em', 'rem', 'vh', 'vw', 'cm', 'in', 'pt']) {
      should(reasonOf(svg(`width="100${unit}" height="100"`))).containEql('unitless, px, or a percentage');
    }
    should(reasonOf(svg('width="calc(100px)" height="100"'))).containEql('unitless, px, or a percentage');
  });

  test('should allow omitted dimensions only behind a bounded positive viewBox', () => {
    should(svg('viewBox="0 0 120 60"').ok).be.true();
    should(svg('width="100" viewBox="0 0 120 60"').ok).be.true();
    should(reasonOf(svg(''))).containEql('must declare width and height');
    should(reasonOf(svg('width="100"'))).containEql('must declare width and height');
    should(reasonOf(svg('viewBox="0 0 0 0"'))).containEql('must declare width and height');
    should(reasonOf(svg('viewBox="0 0 120"'))).containEql('must declare width and height');
  });

  test('should still bound the axis that IS declared when the other is omitted', () => {
    // Assert — an earlier draft returned as soon as either axis was missing
    // behind a viewBox, so the declared one was never looked at. Omission may
    // only mean "inherit the bounded viewBox extent".
    should(reasonOf(svg('width="999999" viewBox="0 0 10 10"'))).containEql('SVG canvas exceeds');
    should(reasonOf(svg('height="999999" viewBox="0 0 10 10"'))).containEql('SVG canvas exceeds');
    should(reasonOf(svg('width="999%" viewBox="0 0 10 10"'))).containEql('at most 100%');
    should(reasonOf(svg('height="999%" viewBox="0 0 10 10"'))).containEql('at most 100%');
    should(reasonOf(svg('width="10em" viewBox="0 0 10 10"'))).containEql('unitless, px, or a percentage');
    should(reasonOf(svg('width="0" viewBox="0 0 10 10"'))).containEql('must be positive');
    // …and a declared axis inside the bounds still passes with the other omitted.
    should(svg('width="120" viewBox="0 0 120 60"').ok).be.true();
  });

  test('should accept a percentage only up to 100 and only against a viewBox', () => {
    should(reasonOf(svg('width="101%" height="100%" viewBox="0 0 120 60"'))).containEql('at most 100%');
    should(reasonOf(svg('width="0%" height="100%" viewBox="0 0 120 60"'))).containEql('at most 100%');
    should(reasonOf(svg('width="100%" height="100%"'))).containEql('percentage dimensions require a bounded viewBox');
  });

  test('should refuse a non-positive declared dimension', () => {
    should(reasonOf(svg('width="0" height="10"'))).containEql('must be positive');
    should(reasonOf(svg('width="-5" height="10"'))).containEql('must be positive');
  });

  test('should treat a bare angle bracket in text as text', () => {
    // Assert — `a < b` is prose, not the start of an element.
    should(sized('<desc>a &lt; b</desc>').ok).be.true();
    should(sized('a < b').ok).be.true();
  });

  test('should read an unquoted attribute value', () => {
    // Assert — XML requires quotes, but a real document may not have them and a
    // reader that stopped there would miss the dimension entirely.
    should(svg('width=10 height=10').ok).be.true();
    should(reasonOf(svg('width=999999 height=10'))).containEql('SVG canvas exceeds');
  });

  test('should keep walking past an attribute that has no value', () => {
    // Assert — a valueless attribute is not the end of the tag, so the real
    // dimensions after it must still be found.
    should(reasonOf(svg('data-flag width="999999" height="10"'))).containEql('SVG canvas exceeds');
    should(svg('data-flag width="10" height="10"').ok).be.true();
    // And one that IS a name we read resolves to empty, which is unresolvable.
    should(reasonOf(svg('width height="10"'))).containEql('unitless, px, or a percentage');
  });
});

describe('fy-render mermaid payloads', () => {
  test('should accept a diagram inside the character cap', () => {
    should(parseFyRender(body('type: mermaid', 'alt: A graph', '---', 'graph TD; A-->B;')).ok).be.true();
  });

  test('should refuse a diagram past the character cap', () => {
    const payload = 'a'.repeat(FY_RENDER_LIMITS.mermaidCharacters + 1);
    should(reasonOf(parseFyRender(body('type: mermaid', 'alt: A graph', '---', payload)))).equal(
      'Mermaid payload exceeds 20,000 characters',
    );
  });
});

describe('fy-render lottie payloads', () => {
  const lottie = (payload: string): FyRenderParseResult =>
    parseFyRender(body('type: lottie', 'alt: A spinner', '---', payload));

  test('should accept a plain animation object', () => {
    should(lottie('{"v":"5.7.0","layers":[{"nm":"one"}],"nm":"spin"}').ok).be.true();
  });

  test('should refuse a payload past the byte cap', () => {
    should(reasonOf(lottie('a'.repeat(FY_RENDER_LIMITS.lottieBytes + 1)))).equal('Lottie payload exceeds 1 MiB');
  });

  test('should refuse text that is not JSON', () => {
    should(reasonOf(lottie('{not json'))).equal('Lottie payload is not valid JSON');
  });

  test('should refuse JSON that is not an object', () => {
    should(reasonOf(lottie('[]'))).equal('Lottie payload must be a JSON object');
    should(reasonOf(lottie('null'))).equal('Lottie payload must be a JSON object');
    should(reasonOf(lottie('7'))).equal('Lottie payload must be a JSON object');
  });

  test('should refuse an expression key at the top level', () => {
    should(reasonOf(lottie('{"x":"time*2"}'))).equal('Lottie expression keys are not accepted');
  });

  test('should refuse an expression key buried under arrays and objects', () => {
    should(reasonOf(lottie('{"assets":[[{"k":{"x":"time*2"}}]]}'))).equal('Lottie expression keys are not accepted');
  });

  test('should refuse a payload nested past the depth cap', () => {
    // Arrange — one array per level, so the depth is exactly the nesting count.
    const depth = FY_RENDER_LIMITS.lottieDepth + 2;
    const payload = `{"a":${'['.repeat(depth)}1${']'.repeat(depth)}}`;

    // Assert
    should(reasonOf(lottie(payload))).equal('Lottie payload exceeds 64 levels of nesting');
  });

  test('should refuse a payload past the layer cap', () => {
    const layers = JSON.stringify(Array.from({ length: FY_RENDER_LIMITS.lottieLayers + 1 }, (_, index) => index));
    should(reasonOf(lottie(`{"layers":${layers}}`))).equal('Lottie payload exceeds 500 layers');
  });

  test('should ignore a layers key that is not an array', () => {
    should(lottie('{"layers":"none","note":null}').ok).be.true();
  });
});

describe('fy-render image payloads', () => {
  const image = (payload: string): FyRenderParseResult =>
    parseFyRender(body('type: image', 'alt: A pixel', 'mime: image/png', '---', payload));

  test('should accept canonical base64 and normalise the wrapping the author typed', () => {
    // Arrange — an authored base64 payload is line-wrapped; the renderer needs
    // the compact form, so the grammar owns the normalisation.
    const wrapped = PIXEL.replace(/(.{8})/gu, '$1\n  ');

    // Act
    const result = image(wrapped);

    // Assert
    should(result).match({ ok: true, block: { payload: PIXEL } });
  });

  test('should refuse an empty payload', () => {
    should(reasonOf(image(''))).equal('Image payload must be canonical base64');
  });

  test('should refuse text that is not canonical base64', () => {
    should(reasonOf(image('not base64!'))).equal('Image payload must be canonical base64');
  });

  test('should refuse a payload past the decoded byte cap', () => {
    // Arrange — unpadded base64 decodes three bytes per four characters.
    const characters = Math.ceil(((FY_RENDER_LIMITS.imageBytes + 1) * 4) / 3 / 4) * 4;
    should(reasonOf(image('A'.repeat(characters)))).equal('Image payload exceeds 2 MiB decoded');
  });
});

/**
 * THE PRE-DECODE BOUND.
 *
 * A 50-byte PNG can declare 65,535 × 65,535 — 17 gigapixels, roughly 68 GB of
 * RGBA — so the payload-size cap is not a weak bound here, it is no bound at
 * all. What IS decidable is what the container declares about itself, and these
 * are the cases that must hold for every retained MIME.
 */
describe('fy-render raster header bounds', () => {
  const image = (mime: string, payload: Uint8Array | string): FyRenderParseResult =>
    parseFyRender(
      body('type: image', 'alt: x', `mime: ${mime}`, '---', typeof payload === 'string' ? payload : base64(payload)),
    );

  test('should accept a well-formed file of every retained type', () => {
    should(image('image/png', png(64, 48)).ok).be.true();
    should(image('image/jpeg', jpeg(sof(64, 48))).ok).be.true();
    should(image('image/gif', gif(64, 48)).ok).be.true();
    should(image('image/webp', webp(64, 48)).ok).be.true();
  });

  test('should no longer offer AVIF, whose primary-item extent it cannot prove', () => {
    // Assert — a decoy `ispe` can understate the item a decoder actually uses,
    // and no decoder-verified sample was available to settle it either way.
    should([...FY_RENDER_IMAGE_MIMES]).not.containEql('image/avif');
    should([...FY_RENDER_IMAGE_MIMES]).eql(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  });

  test('should refuse a decompression bomb that the byte cap cannot see', () => {
    should(reasonOf(image('image/png', png(65535, 65535)))).equal('Image exceeds 8192 pixels on an axis');
  });

  test('should hold each axis and the area at their exact boundaries', () => {
    should(image('image/png', png(8192, 2048)).ok).be.true();
    should(image('image/png', png(4096, 4096)).ok).be.true();
    should(reasonOf(image('image/png', png(8193, 1)))).equal('Image exceeds 8192 pixels on an axis');
    should(reasonOf(image('image/png', png(4096, 4097)))).equal('Image exceeds 16777216 total pixels');
  });

  test('should require the bytes to be the type the author declared', () => {
    // Assert — the allowlist has to gate the DECODER, not the label: a browser
    // sniffs, and would run whichever decoder the bytes actually ask for.
    should(reasonOf(image('image/jpeg', png(10, 10)))).equal('Image bytes are image/png, not the declared image/jpeg');
    should(reasonOf(image('image/png', gif(10, 10)))).equal('Image bytes are image/gif, not the declared image/png');
  });

  test('should refuse animation it has no control to pause', () => {
    should(reasonOf(image('image/png', png(10, 10, APNG_CONTROL)))).containEql('Animated image/png is not accepted');
    should(reasonOf(image('image/gif', gif(10, 10, 2)))).containEql('Animated image/gif is not accepted');
    should(reasonOf(image('image/webp', webp(10, 10, true)))).containEql('Animated image/webp is not accepted');
  });

  test('should refuse an animated WebP whose VP8X flag lies', () => {
    // Arrange — the frame chunks are present while the flag is clear, so a
    // reader of the flag alone would call this static.
    should(reasonOf(image('image/webp', webp(10, 10, false, WEBP_FRAME)))).containEql(
      'Animated image/webp is not accepted',
    );
  });

  test('should read the LARGEST frame a JPEG declares, not the first', () => {
    // Arrange — a small frame header ahead of a huge one would let the decoy
    // decide the bound.
    should(reasonOf(image('image/jpeg', jpeg(sof(10, 10), sof(60000, 60000))))).equal(
      'Image exceeds 8192 pixels on an axis',
    );
  });

  test('should refuse a GIF frame that does not fit the screen it declares', () => {
    should(reasonOf(image('image/gif', gif(10, 10, 1, 5000, 5000)))).equal('Image payload header could not be read');
  });

  test('should fail closed on anything it cannot read', () => {
    for (const payload of [
      bytes(1, 2, 3, 4, 5, 6, 7, 8),
      bytes(0x89, ...chars('PNG\r\n\x1a\n')),
      png(64, 48).slice(0, 20),
      jpeg(sof(64, 48)).slice(0, 12),
      gif(64, 48).slice(0, -1),
      webp(64, 48).slice(0, 20),
    ]) {
      should(reasonOf(image('image/png', payload))).containEql('could not be read');
    }
  });

  test('should refuse a PNG whose IHDR length is not the 13 the spec fixes', () => {
    const wrong = png(64, 48);
    wrong[11] = 12;
    should(reasonOf(image('image/png', wrong))).equal('Image payload header could not be read');
  });

  test('should refuse a WebP whose RIFF size disagrees with the file', () => {
    const lying = webp(64, 48);
    lying[4] = 0xff;
    should(reasonOf(image('image/webp', lying))).equal('Image payload header could not be read');
  });

  test('should read the LARGEST dimension record a WebP carries, not the first', () => {
    // Arrange — a small leading VP8X and a second, much larger one. Gating on
    // the first record would let the small one decide the bound.
    const second = [
      ...chars('VP8X'),
      10,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...[8999, 8999].flatMap(value => [value & 255, (value >> 8) & 255, (value >> 16) & 255]),
    ];
    should(reasonOf(image('image/webp', webp(8, 8, false, second)))).containEql('exceeds');
  });

  test('should refuse a container with bytes after its terminal record', () => {
    // Assert — a walk that does not land exactly on the end of the file has not
    // understood the file, and the brief locks malformed containers fail-closed.
    should(reasonOf(image('image/png', bytes(...png(64, 48), 0, 0, 0)))).equal(
      'Image payload header could not be read',
    );
    should(reasonOf(image('image/gif', bytes(...gif(64, 48), 0, 0)))).equal('Image payload header could not be read');
    should(reasonOf(image('image/webp', bytes(...webp(64, 48), 0)))).equal('Image payload header could not be read');
  });

  test('should refuse a PNG carrying a second, contradictory IHDR', () => {
    // Arrange — a 1×1 first header and a 16384×1 second one. Reading the first
    // and walking past the second lets the decoy set the bound; no real PNG
    // carries two.
    const decoy = png(1, 1, secondIhdr(16384, 1));

    // Assert
    should(reasonOf(image('image/png', decoy))).equal('Image payload header could not be read');
    // …and the oversized one alone is still refused on its dimensions, so the
    // case above cannot be passing for the wrong reason.
    should(reasonOf(image('image/png', png(16384, 1)))).equal('Image exceeds 8192 pixels on an axis');
  });

  test('should refuse a PNG that carries no image data at all', () => {
    // Arrange — signature, header, terminal IEND. Structurally shaped like a
    // PNG and containing no image; Chrome reports an error for the same bytes.
    should(reasonOf(image('image/png', png(64, 48, [], false)))).equal('Image payload header could not be read');
  });

  test('should refuse a PNG whose image data restarts after another chunk', () => {
    // Arrange — IDAT, something else, IDAT again. The specification requires the
    // data chunks to be consecutive, and an ambiguous container fails closed.
    const split = bytes(
      0x89,
      ...chars('PNG\r\n\x1a\n'),
      ...be32(13),
      ...chars('IHDR'),
      ...be32(64),
      ...be32(48),
      8,
      6,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...IDAT,
      ...be32(1),
      ...chars('tEXt'),
      65,
      0,
      0,
      0,
      0,
      ...IDAT,
      ...be32(0),
      ...chars('IEND'),
      0,
      0,
      0,
      0,
    );
    should(reasonOf(image('image/png', split))).equal('Image payload header could not be read');
  });

  test('should refuse a PNG whose IEND claims a length it cannot have', () => {
    // Arrange — the tail is length[4] type[4] crc[4], so the length's low byte is
    // at -12+3 = -9. Mutating -5 would have changed the TYPE and proved nothing
    // about the length check.
    const wrong = png(64, 48);
    should([...wrong.slice(wrong.length - 8, wrong.length - 4)].map(v => String.fromCharCode(v)).join('')).equal(
      'IEND',
    );
    wrong[wrong.length - 9] = 4;

    // Assert
    should(reasonOf(image('image/png', wrong))).equal('Image payload header could not be read');
  });

  test('should walk past JPEG markers that carry no length', () => {
    // Arrange — fill bytes and restart markers are standalone, and a file may
    // reach EOI before any scan. Both are walked, not read as segments.
    const padded = bytes(0xff, 0xd8, 0xff, 0x01, ...sof(64, 48), 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0xff, 0xd9);
    should(image('image/jpeg', padded).ok).be.true();
    // EOI before any scan is a file with no image in it.
    should(reasonOf(image('image/jpeg', bytes(0xff, 0xd8, ...sof(8, 8), 0xff, 0xd9, 0xff, 0xd9)))).containEql(
      'could not be read',
    );
  });

  test('should walk a GIF extension block rather than mistake it for a frame', () => {
    // Arrange — a graphic control extension before the image descriptor, which
    // is what every GIF89a with timing carries.
    const extension = [0x21, 0xf9, 4, 0, 0, 0, 0, 0];
    const withExtension = bytes(
      ...chars('GIF89a'),
      64,
      0,
      48,
      0,
      0,
      0,
      0,
      ...extension,
      0x2c,
      0,
      0,
      0,
      0,
      64,
      0,
      48,
      0,
      0,
      2,
      2,
      0x44,
      1,
      0,
      0x3b,
    );
    should(image('image/gif', withExtension).ok).be.true();
  });

  test('should refuse a GIF whose sub-block chain runs off the end', () => {
    // Arrange — a frame whose data blocks never reach their terminator.
    const runaway = bytes(...chars('GIF89a'), 8, 0, 8, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 8, 0, 8, 0, 0, 2, 9, 1, 2, 3);
    should(reasonOf(image('image/gif', runaway))).equal('Image payload header could not be read');
  });

  test('should read both of WebPs other dimension records', () => {
    // Arrange — lossless (`VP8L`) and lossy (`VP8 `), neither of which is VP8X.
    const riff = (body_: readonly number[]): Uint8Array =>
      bytes(...chars('RIFF'), ...leSize(body_.length + 4), ...chars('WEBP'), ...body_);
    const lossless = (width: number, height: number): Uint8Array => {
      const packed = ((width - 1) | ((height - 1) << 14)) >>> 0;
      // The declared chunk size must match the payload exactly, or the RIFF walk
      // does not land on the end of the file and refuses it.
      return riff([
        ...chars('VP8L'),
        6,
        0,
        0,
        0,
        0x2f,
        packed & 255,
        (packed >>> 8) & 255,
        (packed >>> 16) & 255,
        (packed >>> 24) & 255,
        0,
      ]);
    };
    const lossy = (width: number, height: number): Uint8Array =>
      riff([
        ...chars('VP8 '),
        10,
        0,
        0,
        0,
        0,
        0,
        0,
        0x9d,
        0x01,
        0x2a,
        width & 255,
        (width >> 8) & 255,
        height & 255,
        (height >> 8) & 255,
      ]);

    // Assert
    should(image('image/webp', lossless(64, 48)).ok).be.true();
    should(reasonOf(image('image/webp', lossless(9000, 9000)))).containEql('exceeds');
    should(image('image/webp', lossy(64, 48)).ok).be.true();
    should(reasonOf(image('image/webp', lossy(9000, 9000)))).containEql('exceeds');
  });

  test('should fail closed on a recognised WebP record that is too short to read', () => {
    // Arrange — a valid VP8X, then a truncated one of each kind. Folding the
    // size test into the recognition arm would let the earlier good record carry
    // the file while its real dimension record stayed unreadable.
    const riff = (body_: readonly number[]): Uint8Array =>
      bytes(...chars('RIFF'), ...leSize(body_.length + 4), ...chars('WEBP'), ...body_);
    const goodVp8x: readonly number[] = [...chars('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, 63, 0, 0, 63, 0, 0];
    const stub = (type: string, payload: readonly number[]): readonly number[] => [
      ...chars(type),
      payload.length,
      0,
      0,
      0,
      ...payload,
    ];

    // Assert
    should(image('image/webp', riff([...goodVp8x])).ok).be.true();
    for (const short of [stub('VP8X', [0, 0]), stub('VP8L', [0x2f, 0]), stub('VP8 ', [0, 0, 0, 0x9d])]) {
      should(reasonOf(image('image/webp', riff([...goodVp8x, ...short])))).equal(
        'Image payload header could not be read',
      );
    }
  });

  test('should never admit a raster over the pixel budget, whatever the type', () => {
    // Arrange — the property, stated once rather than per case.
    const over: readonly [string, Uint8Array][] = [
      ['image/png', png(9000, 9000)],
      ['image/jpeg', jpeg(sof(9000, 9000))],
      ['image/gif', gif(9000, 9000)],
      ['image/webp', webp(9000, 9000)],
    ];

    // Assert
    for (const [mime, payload] of over) should(image(mime, payload).ok).be.false();
  });
});
