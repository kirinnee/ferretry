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
/** Four canonical base64 characters, decoding to three bytes. */
const PIXEL = 'AAAA';

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
    should(svg('<svg xmlns="http://www.w3.org/2000/svg"><title>🎉</title></svg>').ok).be.true();
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
    const payload = `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(FY_RENDER_LIMITS.svgElements - 1)}</svg>`;
    should(svg(payload).ok).be.true();
  });

  test('should not treat the word allow-same-origin in a payload as anything at all', () => {
    // Arrange — a payload naming a sandbox token is ordinary text to this
    // grammar, because this build has no frame for a token to affect.
    const payload = '<svg xmlns="http://www.w3.org/2000/svg"><title>allow-same-origin</title></svg>';

    // Act
    const result = parseFyRender(body('type: svg', 'alt: A label', '---', payload));

    // Assert
    should(result).match({ ok: true, block: { payload } });
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
    const result = image('AAAA\nBBBB\n  CCCC');

    // Assert
    should(result).match({ ok: true, block: { payload: 'AAAABBBBCCCC' } });
  });

  test('should accept both padded forms', () => {
    should(image('AAA=').ok).be.true();
    should(image('AA==').ok).be.true();
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
