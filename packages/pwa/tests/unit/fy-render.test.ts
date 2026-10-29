import { describe, test } from 'bun:test';
import should from 'should';
import {
  FY_RENDER_FENCE_ATTRIBUTE,
  FY_RENDER_FENCE_LANGUAGE,
  FY_RENDER_IMAGE_MIMES,
  FY_RENDER_LIMITS,
  FY_RENDER_MEDIA_TYPES,
  FY_RENDER_SANDBOX_LIMITS,
  FY_RENDER_TYPES,
  type FyRenderBlock,
  type FyRenderParseResult,
  fyRenderMediaMime,
  fyRenderPayloadBytes,
  fyRenderPresentation,
  fyRenderRasterRefusal,
  fyRenderReadBoundedBytes,
  fyRenderReadBoundedText,
  isFyRenderMediaBlock,
  parseFyRender,
  remarkFyRenderFences,
} from '../../src/lib/fy-render.ts';
import {
  FY_RENDER_LIMITS as BOUNDS_LIMITS,
  FY_RENDER_SANDBOX_LIMITS as BOUNDS_SANDBOX_LIMITS,
} from '../../src/lib/fy-render-bounds.ts';

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
 * ADMISSION-SHAPED CONTAINERS, built byte by byte.
 *
 * The grammar reads a raster's declared dimensions and record structure before a
 * browser image decoder mounts, so a fixture has to carry the records those
 * checks look at — a signature, the selected record ordering, a terminal shape —
 * rather than four base64 characters. It does NOT have to be a valid image, and
 * these are not: their CRCs are zeros and their pixel data is meaningless. That
 * is the separation under test, so the fixtures are named for it.
 *
 * Building them here rather than pasting opaque base64 is what lets a test say
 * "this PNG declares 65535×65535" and be read as saying that. The dimension
 * reading was cross-checked against Chrome's own encoder: for real PNG, JPEG,
 * WebP and GIF samples at 1×1 through 8192×2048, the parser matched
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
 * An ADMISSION-SHAPED PNG container: the signature, a 13-byte IHDR, optional
 * extra chunks, one IDAT run, and a zero-length terminal IEND at the exact end.
 * Those are the selected records the parser checks and nothing more — the CRCs
 * here are zeros and the IDAT holds two meaningless bytes, so calling it
 * "complete" or "valid" would claim exactly the validation this parser
 * deliberately leaves to the browser decoder. `data: false` omits the IDAT,
 * which is the header-and-end shell that must be refused.
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

/** An admission-shaped JPEG: SOI, the given frame headers, SOS, EOI — no entropy data. */
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

/** An admission-shaped GIF: header, logical screen, `frames` image descriptors, trailer. */
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

/**
 * An admission-shaped WebP: a RIFF whose declared size matches, carrying a VP8X
 * canvas record. A `VP8X` alone is not a decodable WebP — there is no image
 * data here at all — which is exactly why this is named for what the parser
 * reads rather than for being a file.
 */
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

  test('should declare the ten types the block grammar accepts', () => {
    should([...FY_RENDER_TYPES]).eql([
      'html',
      'svg',
      'lottie',
      'mermaid',
      'map',
      'chart',
      'image',
      'video',
      'audio',
      'pdf',
    ]);
  });

  test('should allow a src header on exactly the four media types', () => {
    should([...FY_RENDER_MEDIA_TYPES]).eql(['image', 'video', 'audio', 'pdf']);
  });

  test('should re-export the bounds module rather than keep a second copy of the numbers', () => {
    // Assert — the sandbox shells import the bounds module directly and every
    // other reader imports the grammar, so the two must be the same objects.
    should(FY_RENDER_LIMITS).equal(BOUNDS_LIMITS);
    should(FY_RENDER_SANDBOX_LIMITS).equal(BOUNDS_SANDBOX_LIMITS);
  });

  test('should keep the image MIME allowlist raster-only', () => {
    // Arrange / Assert — an SVG routed through `type: image` would skip every
    // SVG check, so the vector MIME must never be reachable from here.
    should([...FY_RENDER_IMAGE_MIMES]).not.containEql('image/svg+xml');
  });
});

describe('fy-render fence marking', () => {
  interface Node {
    type: string;
    lang?: string | null;
    meta?: string | null;
    children?: Node[];
    data?: { hProperties?: Record<string, unknown> };
  }
  const fence = (lang: string | null, meta: string | null = null, data?: Node['data']): Node => ({
    type: 'code',
    lang,
    meta,
    ...(data === undefined ? {} : { data }),
  });
  const marked = (node: Node): boolean => node.data?.hProperties?.[FY_RENDER_FENCE_ATTRIBUTE] === 'true';

  test('should mark only a code fence whose info string is exactly the language', () => {
    // Arrange — a fence with metadata after the token is a different fence, and
    // so is any other language.
    const exact = fence('fy-render');
    const withMeta = fence('fy-render', 'notes');
    const other = fence('ts');
    const notCode: Node = { type: 'inlineCode', lang: 'fy-render' };
    const root: Node = { type: 'root', children: [exact, withMeta, other, notCode] };

    // Act
    remarkFyRenderFences()(root);

    // Assert
    should([exact, withMeta, other, notCode].map(marked)).eql([true, false, false, false]);
  });

  test('should mark a fence at any depth and keep the properties it already carries', () => {
    // Arrange — inside a list item inside a blockquote, with a label already set.
    const nested = fence('fy-render', '', { hProperties: { 'data-label': 'x' } });
    const root: Node = {
      type: 'root',
      children: [{ type: 'blockquote', children: [{ type: 'listItem', children: [nested] }] }],
    };

    // Act
    remarkFyRenderFences()(root);

    // Assert
    should(nested.data?.hProperties).eql({ 'data-label': 'x', [FY_RENDER_FENCE_ATTRIBUTE]: 'true' });
  });
});

describe('fy-render presentation', () => {
  const accepted = (source: string): FyRenderBlock => {
    const result = parseFyRender(source);
    if (!result.ok) throw new Error(result.reason);
    return result.block;
  };

  test('should route each payload-carrying type to the surface that can actually render it', () => {
    // Arrange
    const blocks = [
      accepted(body('type: html', 'alt: A widget', '---', '<p>hi</p>')),
      accepted(body('type: svg', 'alt: A square', '---', SQUARE)),
      accepted(body('type: lottie', 'alt: A spinner', '---', '{"layers":[]}')),
      accepted(body('type: mermaid', 'alt: A graph', '---', 'graph TD;')),
      accepted(body('type: image', 'alt: A pixel', 'mime: image/png', '---', PIXEL)),
      accepted(body('type: map', 'alt: A city', '---', 'center: [51.5, -0.12]')),
      accepted(body('type: chart', 'alt: A trend', '---', 'kind: line')),
    ];

    // Act
    const presentation = blocks.map(block => [block.type, fyRenderPresentation(block)]);

    // Assert — `html` is a `fragment`: static markup, sanitized, where nothing an author
    // wrote runs. A type moving between these means a different execution
    // surface and wants the threat model re-read.
    should(presentation).eql([
      ['html', 'fragment'],
      ['svg', 'visual'],
      ['lottie', 'sandbox'],
      ['mermaid', 'sandbox'],
      ['image', 'visual'],
      ['map', 'map'],
      ['chart', 'chart'],
    ]);
  });

  test('should present every src block as media, an image included', () => {
    // Arrange — `image` is the one type with two shapes, which is why the
    // presentation is decided by the block and not by its type.
    const blocks = FY_RENDER_MEDIA_TYPES.map(type =>
      accepted(body(`type: ${type}`, 'alt: A file', 'src: https://example.com/file', '---')),
    );

    // Act / Assert
    should(blocks.map(block => fyRenderPresentation(block))).eql(['media', 'media', 'media', 'media']);
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

  test('should refuse an image block with neither a mime nor a src', () => {
    should(reasonOf(parseFyRender(body('type: image', 'alt: A pixel', '---', PIXEL)))).equal(
      'Image blocks require a mime header or a src header',
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

describe('fy-render map payloads', () => {
  test('should accept a map payload inside the byte cap and keep it as written', () => {
    const result = parseFyRender(body('type: map', 'alt: A city', '---', 'center: [51.5, -0.12]'));
    should(result.ok && result.block.type === 'map' ? result.block.payload : null).equal('center: [51.5, -0.12]');
  });

  test('should refuse a map payload past the byte cap', () => {
    const payload = 'a'.repeat(FY_RENDER_LIMITS.mapBytes + 1);
    should(reasonOf(parseFyRender(body('type: map', 'alt: A city', '---', payload)))).equal(
      'Map payload exceeds 32 KiB',
    );
  });

  test('should refuse a map block with nothing to draw', () => {
    should(reasonOf(parseFyRender(body('type: map', 'alt: A city', '---', '   ')))).equal(
      'A map block needs a payload describing it',
    );
  });
});

describe('fy-render chart payloads', () => {
  test('should accept a chart payload inside the byte cap and keep it as written, unread', () => {
    // The grammar bounds the bytes; the chart language is read lazily, with the renderer, by `readChart`.
    const result = parseFyRender(body('type: chart', 'alt: A trend', '---', 'kind: line'));
    should(result.ok && result.block.type === 'chart' ? result.block.payload : null).equal('kind: line');
  });

  test('should refuse a chart payload past the byte cap', () => {
    const payload = 'a'.repeat(FY_RENDER_LIMITS.chartBytes + 1);
    should(reasonOf(parseFyRender(body('type: chart', 'alt: A trend', '---', payload)))).equal(
      'Chart payload exceeds 64 KiB',
    );
  });

  test('should refuse a chart block with nothing to draw', () => {
    should(reasonOf(parseFyRender(body('type: chart', 'alt: A trend', '---', ' ')))).equal(
      'A chart block needs a payload describing it',
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

  test('should refuse a forbidden element a namespace prefix was hiding, in any case', () => {
    // Arrange — lowercase `<svg:script>` IS `<script>`: the prefix is bound to
    // the SVG namespace and a browser resolves the two to the same element.
    // EVERY fixture binds the prefix it uses, so each is a document a parser
    // would accept rather than a malformed string that would have failed anyway
    // — the bypass being proved has to be a real one. XML local names are
    // case-sensitive; the mixed-case cases separately pin the existing,
    // conservative case-insensitive policy. The reported spelling is canonical
    // whatever the author wrote, so one message states one policy.
    const bind = (prefix: string, element: string): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:${prefix}="http://www.w3.org/2000/svg">${element}</svg>`;
    const qualified: readonly (readonly [string, string, string])[] = [
      ['svg', '<svg:script>alert(1)</svg:script>', 'SVG <script> elements are not accepted'],
      ['svg', '<svg:foreignObject><b>hi</b></svg:foreignObject>', 'SVG <foreignObject> elements are not accepted'],
      ['svg', '<svg:use href="#a"/>', 'SVG <use> elements are not accepted'],
      ['SVG', '<SVG:SCRIPT>alert(1)</SVG:SCRIPT>', 'SVG <script> elements are not accepted'],
      ['x', '<x:FOREIGNOBJECT/>', 'SVG <foreignObject> elements are not accepted'],
      ['ns', '<ns:Use href="#a"/>', 'SVG <use> elements are not accepted'],
    ];

    // Act / Assert
    for (const [prefix, element, reason] of qualified) should(reasonOf(svg(bind(prefix, element)))).equal(reason);
  });

  test('should report the first forbidden element in document order', () => {
    // Assert — the scan stops recording at the first one, so a payload carrying
    // several is named for the one that comes first rather than for whichever
    // check happens to be listed first.
    const payload =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><svg:use href="#a"/><script/></svg>';
    should(reasonOf(svg(payload))).equal('SVG <use> elements are not accepted');
  });

  test('should read a forbidden element as markup rather than as text', () => {
    // Assert — the flip side of resolving QNames: the check is a lexical scan
    // now, not a substring search, so a mention of one inside a comment or a
    // CDATA section is character data and stays character data. Neither can
    // become an element, and the element cap already reads both this way.
    should(svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!-- <script/> --></svg>').ok).be.true();
    should(
      svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><![CDATA[<use href="#a"/>]]></svg>').ok,
    ).be.true();
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
    // Assert — a walk that does not land exactly on its terminal record has not
    // exhausted the container, and an unexhausted walk is refused. That is a
    // structural check, not a claim about the bytes inside: CRC and content
    // validity stay the browser decoder's business.
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

/**
 * THE `src:` HEADER. A media block names bytes that live in the session's
 * workspace or behind an https URL, and carries none of its own. Every refusal
 * here is a value an author could plausibly type, so each is pinned by its
 * exact wording.
 */
describe('fy-render src headers', () => {
  const media = (type: string, src: string, ...rest: readonly string[]): FyRenderParseResult =>
    parseFyRender(body(`type: ${type}`, 'alt: A file', `src: ${src}`, '---', ...rest));

  test('should read an @path as a workspace source, session-relative, dot-relative or absolute', () => {
    // Act / Assert — the path is kept exactly as written; resolving it against the
    // session's folder is the reader's job, at read time.
    for (const path of ['docs/chart.png', './chart.png', '/abs/chart.png'])
      should(media('image', `@${path}`)).match({ ok: true, block: { src: { kind: 'workspace', path } } });
  });

  test('should keep the whole body as the source and leave the payload empty', () => {
    // Arrange
    const source = body('type: video', 'alt: A clip', 'src: @clip.mp4', '---');

    // Act / Assert
    should(parseFyRender(source)).eql({
      ok: true,
      block: { alt: 'A clip', payload: '', source, src: { kind: 'workspace', path: 'clip.mp4' }, type: 'video' },
    });
  });

  test('should refuse an @path with a line number, or anything that is not a file reference', () => {
    // Assert — a line suffix means something for source code and nothing for a
    // picture; a bare sigil and a parent traversal are not file references at all.
    for (const src of ['@chart.png:12', '@chart.png:3-4', '@', '@../chart.png', '@a b.png'])
      should(reasonOf(media('image', src))).equal('A workspace src must be an @path to a file, without a line number');
  });

  test('should read an https URL as an https source, in its canonical form', () => {
    should(media('audio', 'https://Example.com/a/../song.mp3')).match({
      ok: true,
      block: { src: { kind: 'https', url: 'https://example.com/song.mp3' } },
    });
  });

  test('should refuse every scheme that is not https, http included', () => {
    for (const src of [
      'http://example.com/a.png',
      'data:image/png;base64,AAAA',
      'blob:x',
      'chart.png',
      'HTTPS://a.com/x',
    ])
      should(reasonOf(media('image', src))).equal('The src header must be an @path, media:<file> or an https:// URL');
  });

  test('should read media:<file> as a file in the session media folder', () => {
    for (const [src, path] of [
      ['media:card.png', 'card.png'],
      ['media:charts/q3.png', 'charts/q3.png'],
    ] as const) {
      const result = parseFyRender(['type: image', 'alt: A chart', `src: ${src}`, '---'].join('\n'));
      should(result.ok && 'src' in result.block ? result.block.src : null).eql({ kind: 'media', path });
    }
  });

  test('should refuse a media path that could leave the folder or is not a name', () => {
    for (const src of [
      'media:',
      'media:/etc/passwd',
      'media:../x.png',
      'media:a//b.png',
      'media:./x.png',
      'media:a b.png',
      'media:a\\b.png',
      'media:a\u0001.png',
    ])
      should(reasonOf(media('image', src))).equal('A media src must be media:<file> inside the session media folder');
  });

  test('should refuse whitespace or a control character inside the URL', () => {
    should(reasonOf(media('image', 'https://example.com/a b.png'))).equal('The src URL must not contain whitespace');
    should(reasonOf(media('image', 'https://example.com/a\u0001.png'))).equal(
      'The src URL must not contain whitespace',
    );
  });

  test('should refuse a URL the platform cannot parse', () => {
    should(reasonOf(media('image', 'https://['))).equal('The src URL could not be parsed');
  });

  test('should refuse a URL carrying credentials, because that is a password in a transcript', () => {
    should(reasonOf(media('image', 'https://user:secret@example.com/a.png'))).equal(
      'The src URL must not carry a user name or password',
    );
    should(reasonOf(media('image', 'https://user@example.com/a.png'))).equal(
      'The src URL must not carry a user name or password',
    );
  });

  test('should hold the src header to its character cap, in either form', () => {
    // Arrange — `https://a.com/` is 14 characters and `@` is one.
    const url = (length: number): string => `https://a.com/${'x'.repeat(length - 14)}`;
    const path = (length: number): string => `@${'x'.repeat(length - 1)}`;

    // Assert
    should(media('image', url(FY_RENDER_LIMITS.srcCharacters)).ok).be.true();
    should(media('image', path(FY_RENDER_LIMITS.srcCharacters)).ok).be.true();
    should(reasonOf(media('image', url(FY_RENDER_LIMITS.srcCharacters + 1)))).equal(
      'The src header exceeds 2048 characters',
    );
    should(reasonOf(media('image', path(FY_RENDER_LIMITS.srcCharacters + 1)))).equal(
      'The src header exceeds 2048 characters',
    );
  });

  test('should refuse a src header on a type that carries its own payload', () => {
    for (const type of ['svg', 'html', 'mermaid', 'lottie'])
      should(reasonOf(media(type, '@a.png'))).equal('The src header is only valid for image, video, audio and pdf');
  });

  test('should refuse an image that names both a mime and a src', () => {
    // Assert — two sources of bytes would leave the reader guessing which one
    // they consented to.
    should(reasonOf(parseFyRender(body('type: image', 'alt: A pixel', 'mime: image/png', 'src: @a.png', '---')))).equal(
      'An image block takes either a mime header or a src header',
    );
  });

  test('should refuse a video, audio or pdf block without a src', () => {
    for (const type of ['video', 'audio', 'pdf'])
      should(reasonOf(parseFyRender(body(`type: ${type}`, 'alt: A file', '---')))).equal(
        `A ${type} block requires a src header`,
      );
  });

  test('should refuse a mime header on a media type that is not image', () => {
    should(reasonOf(parseFyRender(body('type: video', 'alt: A clip', 'mime: image/png', 'src: @a.mp4', '---')))).equal(
      'The mime header is only valid for image blocks',
    );
  });

  test('should refuse a payload beside a src, and accept blank lines as no payload', () => {
    should(reasonOf(media('pdf', '@a.pdf', 'JVBERi0='))).equal('A block with a src header must have an empty payload');
    should(media('pdf', '@a.pdf', '', '   ', '')).match({ ok: true, block: { payload: '', type: 'pdf' } });
  });
});

describe('fy-render media blocks', () => {
  const block = (source: string): FyRenderBlock => {
    const result = parseFyRender(source);
    if (!result.ok) throw new Error(result.reason);
    return result.block;
  };

  test('should name a src block as media and an inline one as not', () => {
    // Assert — an inline image is the same type as a src one and must not be
    // mistaken for it.
    should(isFyRenderMediaBlock(block(body('type: image', 'alt: A file', 'src: @a.png', '---')))).be.true();
    should(
      isFyRenderMediaBlock(block(body('type: video', 'alt: A clip', 'src: https://a.com/v.mp4', '---'))),
    ).be.true();
    should(
      isFyRenderMediaBlock(block(body('type: image', 'alt: A pixel', 'mime: image/png', '---', PIXEL))),
    ).be.false();
    should(isFyRenderMediaBlock(block(body('type: svg', 'alt: A square', '---', SQUARE)))).be.false();
  });

  test('should report no payload bytes for a media block, whatever its type', () => {
    // Assert — the consent control names this number, and a src block's bytes
    // are not known until they are read.
    should(fyRenderPayloadBytes(block(body('type: image', 'alt: A file', 'src: @a.png', '---')))).equal(0);
    should(fyRenderPayloadBytes(block(body('type: audio', 'alt: A song', 'src: @a.mp3', '---')))).equal(0);
  });

  test('should report the bytes an inline payload actually spends', () => {
    // Assert — UTF-8 bytes for text, decoded bytes for base64.
    should(fyRenderPayloadBytes(block(body('type: html', 'alt: A widget', '---', 'é')))).equal(2);
    should(fyRenderPayloadBytes(block(body('type: image', 'alt: A pixel', 'mime: image/png', '---', PIXEL)))).equal(
      png(1, 1).byteLength,
    );
  });
});

describe('fy-render media MIME by extension', () => {
  test('should map every extension each media type shows', () => {
    // Arrange
    const expected: readonly (readonly [Parameters<typeof fyRenderMediaMime>[0], string, string])[] = [
      ['audio', 'aac', 'audio/aac'],
      ['audio', 'flac', 'audio/flac'],
      ['audio', 'm4a', 'audio/mp4'],
      ['audio', 'mp3', 'audio/mpeg'],
      ['audio', 'oga', 'audio/ogg'],
      ['audio', 'ogg', 'audio/ogg'],
      ['audio', 'opus', 'audio/ogg'],
      ['audio', 'wav', 'audio/wav'],
      ['audio', 'weba', 'audio/webm'],
      ['image', 'gif', 'image/gif'],
      ['image', 'jpeg', 'image/jpeg'],
      ['image', 'jpg', 'image/jpeg'],
      ['image', 'png', 'image/png'],
      ['image', 'webp', 'image/webp'],
      ['pdf', 'pdf', 'application/pdf'],
      ['video', 'm4v', 'video/mp4'],
      ['video', 'mov', 'video/quicktime'],
      ['video', 'mp4', 'video/mp4'],
      ['video', 'ogv', 'video/ogg'],
      ['video', 'webm', 'video/webm'],
    ];

    // Act / Assert
    for (const [type, extension, mime] of expected)
      should(fyRenderMediaMime(type, `dir/file.${extension}`)).equal(mime);
  });

  test('should read the extension case-insensitively', () => {
    should(fyRenderMediaMime('image', 'Photo.PNG')).equal('image/png');
    should(fyRenderMediaMime('pdf', 'REPORT.Pdf')).equal('application/pdf');
  });

  test('should show nothing for a file with no extension of its own', () => {
    // Assert — a dot in a DIRECTORY name is not the file's extension.
    should(fyRenderMediaMime('image', 'README')).be.null();
    should(fyRenderMediaMime('image', 'a.b/c')).be.null();
    should(fyRenderMediaMime('image', 'photos.png/raw')).be.null();
  });

  test('should show nothing for an extension the type does not handle', () => {
    // Assert — an extension is only meaningful for its own type: an mp4 is not an
    // image, and an svg goes through `type: svg`, never through `src:`.
    should(fyRenderMediaMime('image', 'clip.mp4')).be.null();
    should(fyRenderMediaMime('image', 'logo.svg')).be.null();
    should(fyRenderMediaMime('video', 'song.mp3')).be.null();
    should(fyRenderMediaMime('pdf', 'notes.txt')).be.null();
  });
});

/**
 * THE SAME ADMISSION, FOR BYTES THAT ARRIVE LATER. A `src:` image has no bytes
 * at parse time, so the renderer runs this gate on what the read returned; these
 * pin that it is the same gate the inline path uses.
 */
describe('fy-render raster refusal for fetched bytes', () => {
  test('should accept any of the four rasters when nothing was declared', () => {
    // Assert — the https case, where a URL suffix is not a declaration.
    for (const raster of [png(64, 48), jpeg(sof(64, 48)), gif(64, 48), webp(64, 48)])
      should(fyRenderRasterRefusal(raster, null)).be.null();
  });

  test('should accept bytes that are the type that was declared', () => {
    should(fyRenderRasterRefusal(png(64, 48), 'image/png')).be.null();
    should(fyRenderRasterRefusal(webp(64, 48), 'image/webp')).be.null();
  });

  test('should refuse bytes that are not the type the extension declared', () => {
    should(fyRenderRasterRefusal(gif(10, 10), 'image/jpeg')).equal(
      'Image bytes are image/gif, not the declared image/jpeg',
    );
  });

  test('should refuse an animation, even with nothing declared', () => {
    should(fyRenderRasterRefusal(gif(10, 10, 2), null)).equal(
      'Animated image/gif is not accepted, because this build has no pause control',
    );
  });

  test('should refuse an oversized axis and an oversized area', () => {
    should(fyRenderRasterRefusal(png(8193, 1), null)).equal('Image exceeds 8192 pixels on an axis');
    should(fyRenderRasterRefusal(png(4096, 4097), null)).equal('Image exceeds 16777216 total pixels');
  });

  test('should refuse bytes it cannot read, whatever was declared', () => {
    should(fyRenderRasterRefusal(new Uint8Array(0), null)).equal('Image payload header could not be read');
    should(fyRenderRasterRefusal(bytes(...chars('%PDF-1.7')), 'image/png')).equal(
      'Image payload header could not be read',
    );
  });
});

describe('fy-render bounded byte reading', () => {
  const streamOf = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  const reasonOfRead = (result: { readonly ok: true } | { readonly ok: false; readonly reason: string }): string =>
    result.ok ? '<accepted>' : result.reason;

  test('should join every chunk of a body inside the cap', async () => {
    // Act
    const result = await fyRenderReadBoundedBytes(new Response(streamOf([bytes(1, 2), bytes(3), bytes(4, 5)])), 5);

    // Assert — exactly at the cap is inside it.
    should(result.ok).be.true();
    should(result.ok ? [...result.bytes] : []).eql([1, 2, 3, 4, 5]);
  });

  test('should read an empty body as zero bytes rather than as a missing one', async () => {
    // Act
    const result = await fyRenderReadBoundedBytes(new Response(streamOf([])), 5);

    // Assert
    should(result.ok ? result.bytes.byteLength : -1).equal(0);
  });

  test('should refuse a declared length over the cap without reading the body', async () => {
    // Arrange — the body is a stream that records whether it was ever pulled.
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body, { headers: { 'content-length': '6' } });

    // Act
    const result = await fyRenderReadBoundedBytes(response, 5);

    // Assert
    should(reasonOfRead(result)).equal('The library response is too large');
    should(pulled).be.false();
  });

  test('should ignore a declared length it cannot read and count the bytes instead', async () => {
    // Act
    const result = await fyRenderReadBoundedBytes(
      new Response(streamOf([bytes(1)]), { headers: { 'content-length': 'lots' } }),
      5,
    );

    // Assert
    should(result.ok).be.true();
  });

  test('should cancel a stream at the chunk that crosses the cap', async () => {
    // Arrange — a stream that never ends on its own, so only a cancel stops it.
    let cancelled = false;
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });

    // Act
    const result = await fyRenderReadBoundedBytes(new Response(endless), 10, 'image');

    // Assert — the third chunk takes the total to 12, past the cap of 10.
    should(reasonOfRead(result)).equal('The image response is too large');
    should(cancelled).be.true();
    should(sent).be.belowOrEqual(4);
  });

  test('should refuse a response with no body at all', async () => {
    should(reasonOfRead(await fyRenderReadBoundedBytes(new Response(null, { status: 204 }), 5, 'image'))).equal(
      'The image response was empty',
    );
  });

  test('should refuse a stream that fails mid-read', async () => {
    // Arrange
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(1));
        controller.error(new Error('connection reset'));
      },
    });

    // Act / Assert
    should(reasonOfRead(await fyRenderReadBoundedBytes(new Response(failing), 5, 'image'))).equal(
      'The image response could not be read',
    );
  });

  test('should still decode text through the byte reader and pass its refusals through', async () => {
    // Assert — the text reader is a wrapper, and its refusals name a library.
    should(await fyRenderReadBoundedText(new Response('héllo'), 10)).eql({ ok: true, text: 'héllo' });
    should(await fyRenderReadBoundedText(new Response('héllo'), 5)).eql({
      ok: false,
      reason: 'The library response is too large',
    });
  });
});
