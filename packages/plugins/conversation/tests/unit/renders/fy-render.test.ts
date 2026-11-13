import { describe, test } from 'bun:test';
import should from 'should';
import {
  FY_RENDER_IMAGE_MIMES,
  FY_RENDER_LIMITS,
  FY_RENDER_MEDIA_TYPES,
  FY_RENDER_TYPES,
  fyRenderHtmlRunsScript,
  parseFyRenderHeaders,
  validateHtml,
  validateSvg,
} from '../../../contract/index.ts';

/**
 * The grammar core, read as a grammar. Every assertion here is about what the
 * shared reader accepts and what it refuses — never about how a block looks —
 * because this is the module the daemon will validate a saved picture with, and
 * the PWA's fence reader composes it unchanged (its own suite pins that
 * composition end to end).
 *
 * These tests deal in payloads and header LINES, never in fence openers or
 * bodies: `scripts/validate/no-fy-render-in-docs.sh` fails any tracked file
 * outside the teaching documents that contains the opener, and a test file is a
 * tracked file.
 */

const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

const headerReason = (lines: readonly string[]): string => {
  const headers = parseFyRenderHeaders(lines);
  return typeof headers === 'string' ? headers : '<accepted>';
};

describe('fy-render types', () => {
  test('should declare the twelve types the block grammar accepts', () => {
    should([...FY_RENDER_TYPES]).eql([
      'html',
      'svg',
      'lottie',
      'mermaid',
      'map',
      'chart',
      'card',
      'board',
      'image',
      'video',
      'audio',
      'pdf',
    ]);
  });

  test('should allow a src header on exactly the four media types', () => {
    should([...FY_RENDER_MEDIA_TYPES]).eql(['image', 'video', 'audio', 'pdf']);
  });

  test('should keep the image MIME allowlist raster-only', () => {
    // Assert — an SVG routed through `type: image` would skip every
    // SVG check, so the vector MIME must never be reachable from here.
    should([...FY_RENDER_IMAGE_MIMES]).not.containEql('image/svg+xml');
  });
});

describe('fy-render headers', () => {
  test('should accept minimal well-formed headers', () => {
    // Assert — the `src` value is deliberately NOT parsed here: it comes back
    // exactly as authored, because parsing it is the PWA's media layer's job.
    should(parseFyRenderHeaders(['type: mermaid', 'alt: A sequence'])).match({
      type: 'mermaid',
      alt: 'A sequence',
      mime: undefined,
      src: undefined,
    });
    should(parseFyRenderHeaders(['type: image', 'alt: A pixel', 'src: @shot.png'])).match({
      type: 'image',
      alt: 'A pixel',
      mime: undefined,
      src: '@shot.png',
    });
  });

  test('should refuse no header lines at all', () => {
    should(parseFyRenderHeaders([])).equal('Missing fy-render headers');
  });

  test('should refuse a header line that is not exactly key: value', () => {
    should(headerReason(['type = svg'])).containEql('"key: value" form');
  });

  test('should refuse a header key outside the closed set', () => {
    should(headerReason(['type: svg', 'alt: A square', 'width: 40'])).equal('Unknown fy-render header: width');
  });

  test('should refuse a repeated header key', () => {
    should(headerReason(['type: svg', 'alt: one', 'alt: two'])).equal('Duplicate fy-render header: alt');
  });

  test('should refuse a block whose first header line is not type', () => {
    // Assert — the grammar declares the type on the FIRST line, so a block
    // that merely contains a type header somewhere is not one.
    should(headerReason(['alt: A square', 'type: svg'])).equal('The first header line must declare type');
  });

  test('should refuse a block with no type header at all', () => {
    should(headerReason(['alt: A square'])).equal('The first header line must declare type');
  });

  test('should refuse a type outside the declared twelve', () => {
    should(headerReason(['type: webgl', 'alt: A square'])).equal('Unknown fy-render type: webgl');
  });

  test('should refuse a block with no alt, because an inaccessible block is not a degraded render', () => {
    should(headerReason(['type: svg'])).equal('Missing required alt header');
  });

  test('should refuse empty alt text', () => {
    should(headerReason(['type: svg', 'alt: '])).equal('Alt text must not be empty');
  });

  test('should refuse control characters in alt text', () => {
    should(headerReason(['type: svg', 'alt: a\tb'])).containEql('control characters');
  });

  test('should refuse alt text past the character cap', () => {
    const alt = 'a'.repeat(FY_RENDER_LIMITS.altCharacters + 1);
    should(headerReason(['type: svg', `alt: ${alt}`])).equal('Alt text exceeds 200 characters');
  });

  test('should accept alt text exactly at the character cap', () => {
    const alt = 'a'.repeat(FY_RENDER_LIMITS.altCharacters);
    should(typeof parseFyRenderHeaders(['type: svg', `alt: ${alt}`])).equal('object');
  });

  test('should refuse an image block with neither a mime nor a src', () => {
    should(headerReason(['type: image', 'alt: A pixel'])).equal('Image blocks require a mime header or a src header');
  });

  test('should refuse a mime header on a non-image block', () => {
    should(headerReason(['type: svg', 'alt: A square', 'mime: image/png'])).equal(
      'The mime header is only valid for image blocks',
    );
  });

  test('should refuse a mime outside the raster allowlist', () => {
    should(headerReason(['type: image', 'alt: A pixel', 'mime: image/svg+xml'])).equal(
      'Unsupported image MIME type: image/svg+xml',
    );
  });

  test('should refuse a src header on a type that carries its own payload', () => {
    should(headerReason(['type: svg', 'alt: A square', 'src: @square.svg'])).equal(
      'The src header is only valid for image, video, audio and pdf',
    );
  });

  test('should refuse an image that names both a mime and a src', () => {
    should(headerReason(['type: image', 'alt: A pixel', 'mime: image/png', 'src: @pixel.png'])).equal(
      'An image block takes either a mime header or a src header',
    );
  });

  test('should refuse a video, audio or pdf block without a src', () => {
    for (const type of ['video', 'audio', 'pdf'])
      should(headerReason([`type: ${type}`, 'alt: A file'])).equal(`A ${type} block requires a src header`);
  });

  test('should refuse a mime header on a media type that is not image', () => {
    should(headerReason(['type: video', 'alt: A clip', 'mime: video/mp4', 'src: @clip.mp4'])).equal(
      'The mime header is only valid for image blocks',
    );
  });
});

describe('fy-render html payloads', () => {
  test('should accept an HTML payload inside the byte cap', () => {
    should(validateHtml('<p>hello</p>')).be.null();
  });

  test('should refuse an HTML payload past the byte cap', () => {
    const payload = 'a'.repeat(FY_RENDER_LIMITS.htmlBytes + 1);
    should(validateHtml(payload)).equal('HTML payload exceeds 200 KiB');
  });

  test('should answer whether an html payload asks to run, without parsing it', () => {
    // Assert — a ROUTE, not a gate: a `<script` or a handler-shaped attribute
    // anywhere, comments and attribute values included, sends the page to the
    // frame where author code is allowed to run anyway.
    should(fyRenderHtmlRunsScript('<p>hello</p>')).be.false();
    should(fyRenderHtmlRunsScript('<p onclick="x">hello</p>')).be.true();
    should(fyRenderHtmlRunsScript('<svg/onload=alert(1)>')).be.true();
    should(fyRenderHtmlRunsScript('<!-- <script>alert(1)</script> --><p>hi</p>')).be.true();
    should(fyRenderHtmlRunsScript('<p>script</p>')).be.false();
  });
});

describe('fy-render svg payloads', () => {
  const svg = (payload: string): string | null => validateSvg(payload);

  test('should accept a plain SVG payload', () => {
    should(svg(SQUARE)).be.null();
  });

  test('should accept an SVG behind a declaration, a processing instruction and a comment', () => {
    should(svg(`<?xml version="1.0"?>\n<!-- drawn by hand -->\n${SQUARE}`)).be.null();
  });

  test('should refuse an SVG payload past the byte cap', () => {
    should(svg('a'.repeat(FY_RENDER_LIMITS.svgBytes + 1))).equal('SVG payload exceeds 100 KiB');
  });

  test('should refuse document type and entity declarations', () => {
    should(svg(`<!DOCTYPE svg>${SQUARE}`)).containEql('entity declarations are not accepted');
    should(svg(`<!ENTITY lol "lol">${SQUARE}`)).containEql('entity declarations are not accepted');
  });

  test('should refuse a payload that does not begin with an svg element', () => {
    should(svg('<div><svg/></div>')).equal('SVG payload must begin with an <svg> element');
  });

  test('should refuse a script element', () => {
    should(svg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).equal(
      'SVG <script> elements are not accepted',
    );
  });

  test('should refuse a foreignObject element', () => {
    should(svg('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>')).equal(
      'SVG <foreignObject> elements are not accepted',
    );
  });

  test('should refuse a use element rather than detect its cycles', () => {
    should(svg('<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/></svg>')).equal(
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
    for (const [prefix, element, reason] of qualified) should(svg(bind(prefix, element))).equal(reason);
  });

  test('should report the first forbidden element in document order', () => {
    // Assert — the scan stops recording at the first one, so a payload carrying
    // several is named for the one that comes first rather than for whichever
    // check happens to be listed first.
    const payload =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><svg:use href="#a"/><script/></svg>';
    should(svg(payload)).equal('SVG <use> elements are not accepted');
  });

  test('should read a forbidden element as markup rather than as text', () => {
    // Assert — the flip side of resolving QNames: the check is a lexical scan
    // now, not a substring search, so a mention of one inside a comment or a
    // CDATA section is character data and stays character data. Neither can
    // become an element, and the element cap already reads both this way.
    should(svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!-- <script/> --></svg>')).be.null();
    should(
      svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><![CDATA[<use href="#a"/>]]></svg>'),
    ).be.null();
  });

  test('should refuse an unpaired UTF-16 surrogate, because the renderer cannot encode one', () => {
    // Arrange — `encodeURIComponent` throws `URIError` on a lone surrogate, and
    // the renderer builds the `data:` URL with it. A payload the grammar accepts
    // must never be able to throw downstream.
    const lone = String.fromCharCode(0xd800);

    // Assert
    should(svg(`<svg xmlns="http://www.w3.org/2000/svg"><title>${lone}</title></svg>`)).equal(
      'SVG payload contains an unpaired UTF-16 surrogate',
    );
  });

  test('should accept a well-formed surrogate pair, which is one ordinary code point', () => {
    // Arrange / Assert — the refusal above must not cost authors emoji.
    should(svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>🎉</title></svg>')).be.null();
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
      if (validateSvg(payload) !== null) continue;
      should(() => encodeURIComponent(payload)).not.throw();
    }
  });

  test('should refuse a payload past the element cap', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(FY_RENDER_LIMITS.svgElements)}</svg>`;
    should(svg(payload)).equal('SVG payload exceeds 500 elements');
  });

  test('should accept a payload exactly at the element cap', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${'<g/>'.repeat(FY_RENDER_LIMITS.svgElements - 2)}</svg>`;
    should(svg(payload)).be.null();
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
  const svg = (attributes: string, body_ = ''): string | null =>
    validateSvg(`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body_}</svg>`);
  const sized = (body_: string): string | null => svg('width="10" height="10"', body_);

  test('should count every XML NameStartChar class, not just ASCII letters', () => {
    for (const tag of ['<_/>', '<:a/>', '<À/>', '<_a/>', '<g/>']) {
      should(sized(tag.repeat(FY_RENDER_LIMITS.svgElements + 1))).equal('SVG payload exceeds 500 elements');
      should(sized(tag.repeat(FY_RENDER_LIMITS.svgElements - 1))).be.null();
    }
  });

  test('should not count tag-like text that is not a tag', () => {
    // Assert — a regex would read all three of these as 600 elements, and the
    // documented fact is "element opening tags".
    should(sized(`<!-- ${'<g/>'.repeat(600)} -->`)).be.null();
    should(sized(`<![CDATA[${'<g/>'.repeat(600)}]]>`)).be.null();
    should(sized('</g>'.repeat(600))).be.null();
  });

  test('should refuse a document whose comment, CDATA or tag never closes', () => {
    should(sized('<!-- never closes')).containEql('unterminated');
    should(sized('<![CDATA[ never closes')).containEql('unterminated');
    // A tag has to run off the END of the document to be unterminated: inside
    // the wrapper above, the closing `</svg>` would supply the `>`.
    should(validateSvg('<svg width="10" height="10"><g ')).containEql('unterminated');
  });

  test('should cap filter primitives, counting a namespace prefix by local name', () => {
    for (const tag of ['<feGaussianBlur/>', '<svg:feGaussianBlur/>']) {
      should(sized(tag.repeat(FY_RENDER_LIMITS.svgFilterPrimitives + 1))).equal(
        'SVG payload exceeds 32 filter primitives',
      );
      should(sized(tag.repeat(FY_RENDER_LIMITS.svgFilterPrimitives))).be.null();
    }
  });

  test('should read the real width, not a decoy attribute that merely ends in one', () => {
    // Assert — a word-boundary match reads `data-width` and `x:width` as
    // `width`, so a small decoy first would decide the bound for an oversized
    // real dimension after it.
    should(svg('data-width="10" width="999999" height="10"')).containEql('SVG canvas exceeds');
    should(svg('x:width="10" width="999999" height="10"')).containEql('SVG canvas exceeds');
    should(svg('data-width="999999" width="10" height="10"')).be.null();
  });

  test('should not let a quoted angle bracket hide the attributes after it', () => {
    // Assert — `[^>]*` stops at the `>` inside the title and never sees `width`.
    should(svg('title="a > b" width="999999" height="10"')).containEql('SVG canvas exceeds');
  });

  test('should bound each axis independently when the units differ', () => {
    // Assert — an earlier draft accepted the pair as soon as it saw a valid
    // percentage, so the oversized px axis rode in on the axis that was fine.
    should(svg('width="100%" height="999999px" viewBox="0 0 10 10"')).containEql('SVG canvas exceeds');
    should(svg('width="999999px" height="100%" viewBox="0 0 10 10"')).containEql('SVG canvas exceeds');
    should(svg('width="100%" height="100%" viewBox="0 0 120 60"')).be.null();
  });

  test('should hold the canvas at its exact boundaries', () => {
    should(svg('width="8192" height="2048"')).be.null();
    should(svg('width="4096" height="4096"')).be.null();
    should(svg('width="8193" height="1"')).containEql('SVG canvas exceeds');
    should(svg('width="4096" height="4097"')).containEql('SVG canvas exceeds');
    should(svg('viewBox="0 0 100000 100000"')).containEql('SVG viewBox exceeds');
  });

  test('should refuse a unit it cannot resolve rather than guess at it', () => {
    for (const unit of ['em', 'rem', 'vh', 'vw', 'cm', 'in', 'pt']) {
      should(svg(`width="100${unit}" height="100"`)).containEql('unitless, px, or a percentage');
    }
    should(svg('width="calc(100px)" height="100"')).containEql('unitless, px, or a percentage');
  });

  test('should allow omitted dimensions only behind a bounded positive viewBox', () => {
    should(svg('viewBox="0 0 120 60"')).be.null();
    should(svg('width="100" viewBox="0 0 120 60"')).be.null();
    should(svg('')).containEql('must declare width and height');
    should(svg('width="100"')).containEql('must declare width and height');
    should(svg('viewBox="0 0 0 0"')).containEql('must declare width and height');
    should(svg('viewBox="0 0 120"')).containEql('must declare width and height');
  });

  test('should still bound the axis that IS declared when the other is omitted', () => {
    // Assert — an earlier draft returned as soon as either axis was missing
    // behind a viewBox, so the declared one was never looked at. Omission may
    // only mean "inherit the bounded viewBox extent".
    should(svg('width="999999" viewBox="0 0 10 10"')).containEql('SVG canvas exceeds');
    should(svg('height="999999" viewBox="0 0 10 10"')).containEql('SVG canvas exceeds');
    should(svg('width="999%" viewBox="0 0 10 10"')).containEql('at most 100%');
    should(svg('height="999%" viewBox="0 0 10 10"')).containEql('at most 100%');
    should(svg('width="10em" viewBox="0 0 10 10"')).containEql('unitless, px, or a percentage');
    should(svg('width="0" viewBox="0 0 10 10"')).containEql('must be positive');
    // …and a declared axis inside the bounds still passes with the other omitted.
    should(svg('width="120" viewBox="0 0 120 60"')).be.null();
  });

  test('should accept a percentage only up to 100 and only against a viewBox', () => {
    should(svg('width="101%" height="100%" viewBox="0 0 120 60"')).containEql('at most 100%');
    should(svg('width="0%" height="100%" viewBox="0 0 120 60"')).containEql('at most 100%');
    should(svg('width="100%" height="100%"')).containEql('percentage dimensions require a bounded viewBox');
  });

  test('should refuse a non-positive declared dimension', () => {
    should(svg('width="0" height="10"')).containEql('must be positive');
    should(svg('width="-5" height="10"')).containEql('must be positive');
  });

  test('should treat a bare angle bracket in text as text', () => {
    // Assert — `a < b` is prose, not the start of an element.
    should(sized('<desc>a &lt; b</desc>')).be.null();
    should(sized('a < b')).be.null();
  });

  test('should read an unquoted attribute value', () => {
    // Assert — XML requires quotes, but a real document may not have them and a
    // reader that stopped there would miss the dimension entirely.
    should(svg('width=10 height=10')).be.null();
    should(svg('width=999999 height=10')).containEql('SVG canvas exceeds');
  });

  test('should keep walking past an attribute that has no value', () => {
    // Assert — a valueless attribute is not the end of the tag, so the real
    // dimensions after it must still be found.
    should(svg('data-flag width="999999" height="10"')).containEql('SVG canvas exceeds');
    should(svg('data-flag width="10" height="10"')).be.null();
    // And one that IS a name we read resolves to empty, which is unresolvable.
    should(svg('width height="10"')).containEql('unitless, px, or a percentage');
  });
});
