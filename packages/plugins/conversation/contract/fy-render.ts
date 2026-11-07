/**
 * The `fy-render` grammar core that both ends of a saved picture must agree on:
 * the shared header/alt parsing, the `svg` lexical rules and the `html` checks.
 *
 * WHY THIS IS IN PROTOCOL. A picture saved as a daemon file is validated where
 * it is saved, with the same parser the reader runs, so a save the daemon
 * refuses is exactly a block the PWA would have refused. That parser has to live
 * above both of them, in the package every consumer already depends on. The
 * fence-to-block reader and every other type's parsing stay in
 * `packages/pwa/src/lib/fy-render.ts`, which re-imports from here; nothing
 * about what a payload may contain changed in the move.
 *
 * NOTHING HERE EXECUTES A PAYLOAD. This module is a pure string reader: it
 * turns authored bytes into a validated description, or into a refusal with a
 * human-readable reason. It has no DOM dependency, no timer, no network call,
 * and no side effect — which is also why the daemon can run it: there is
 * nothing here that only a browser has.
 *
 * THE VALIDATION HERE IS A BOUND, NOT A SANITISER, and not a promise of a
 * precise refusal either. It rejects a few obviously unsupported constructs and
 * caps how much work a parser can be made to do. It does NOT enumerate what an
 * SVG may contain: external image, font, stylesheet and paint references, SMIL,
 * `onload`/`onerror` attributes and `javascript:` anchors are all ACCEPTED here
 * and simply render inert or incomplete in the reader. Measured, not assumed —
 * a real-Chromium probe put 15 of 25 hostile payloads straight through these
 * checks and every one of them was harmless because of the SINK, not because of
 * the scan. The sink lives in the PWA and is exactly one thing: an authored SVG
 * reaches a page only as the `src` of an HTML `<img>`, as a `data:image/svg+xml,…`
 * URL. Do NOT generalise that to inline SVG, `<object>`, `<embed>`, `<iframe>`,
 * a CSS image or paint consumer, or a blob URL used for anything else.
 * `docs/fy-render.md` cites the ledger.
 *
 * So: weakening a check here is an authoring-feedback regression; changing where
 * these bytes are consumed is a security regression.
 */

import { FY_RENDER_LIMITS } from './fy-render-caps.ts';

export const FY_RENDER_TYPES = [
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
] as const;
export type FyRenderType = (typeof FY_RENDER_TYPES)[number];

/** The types a `src:` header may name, and the only ones it may appear on. */
export const FY_RENDER_MEDIA_TYPES = ['image', 'video', 'audio', 'pdf'] as const;
export type FyRenderMediaType = (typeof FY_RENDER_MEDIA_TYPES)[number];

/**
 * Raster MIME types only, and static ones.
 *
 * `image/svg+xml` is absent because an author who wants an SVG uses `type: svg`
 * and gets the SVG checks, rather than routing a vector payload past them
 * through a MIME string.
 *
 * `image/avif` is absent DELIBERATELY and is a declared gap, not an oversight.
 * An AVIF carries per-item `ispe` extents, and deciding which one a decoder will
 * actually use means resolving `pitm` into `ipma` property associations; a
 * parser that reads the first box lets a small decoy mask a huge primary item,
 * which was measured. Taking the maximum over every `ispe` closes that, but no
 * real AVIF sample or sequence fixture was available to verify either the parser
 * or the animation exclusion against a decoder — and an allowlist entry that
 * cannot be demonstrated is a claim that cannot be backed. It returns when a
 * decoder-verified sample and an adversarial primary-item fixture exist.
 */
export const FY_RENDER_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type FyRenderImageMime = (typeof FY_RENDER_IMAGE_MIMES)[number];

const UTF8 = new TextEncoder();
const HEADER_LINE = /^([a-z]+): (.*)$/u;

const byteLength = (value: string): number => UTF8.encode(value).byteLength;
const characterLength = (value: string): number => [...value].length;

/**
 * C0 controls and DEL, by code point rather than by a character class: a regex
 * spelling this range puts literal control characters in the source, which the
 * linter rejects on exactly the grounds that make them hard to review.
 */
const hasControlCharacter = (value: string): boolean =>
  [...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

const isFyRenderType = (value: string): value is FyRenderType => FY_RENDER_TYPES.some(type => type === value);
const isMediaType = (type: FyRenderType): type is FyRenderMediaType =>
  FY_RENDER_MEDIA_TYPES.some(media => media === type);
const isImageMime = (value: string): value is FyRenderImageMime => FY_RENDER_IMAGE_MIMES.some(mime => mime === value);

/**
 * Which keys go with which type, decided once the type is known.
 *
 * `image` is the one type with two shapes, and they are exclusive: `mime:` with
 * an inline base64 payload, or `src:` with none. Allowing both would leave the
 * reader guessing which bytes they consented to.
 */
function headerShapeRefusal(type: FyRenderType, mime: string | undefined, src: string | undefined): string | null {
  if (src !== undefined && !isMediaType(type)) return 'The src header is only valid for image, video, audio and pdf';
  if (type === 'image') {
    if (mime !== undefined && src !== undefined) return 'An image block takes either a mime header or a src header';
    if (mime === undefined && src === undefined) return 'Image blocks require a mime header or a src header';
    return null;
  }
  if (mime !== undefined) return 'The mime header is only valid for image blocks';
  if (isMediaType(type) && src === undefined) return `A ${type} block requires a src header`;
  return null;
}

/**
 * The header lines of a fence body, read but for one deliberate exception: the
 * `src:` VALUE. Its parsing — an `@path` read by the reference grammar's own
 * token reader, a `media:<file>` name, an `https://` URL — is media validation,
 * which stayed in the PWA with the media types it belongs to, because it is the
 * one arm whose grammar (`parseReferenceToken`) is the PWA's. This module hands
 * the raw value back and the caller parses it in the same position in the
 * refusal order, so the observable behaviour of a full read is unchanged.
 */
export interface FyRenderParsedHeaders {
  readonly type: FyRenderType;
  readonly alt: string;
  readonly mime: FyRenderImageMime | undefined;
  /** The `src:` header's value exactly as authored, unparsed; absent when there is no header. */
  readonly src: string | undefined;
}

const HEADER_KEYS: readonly string[] = ['type', 'alt', 'mime', 'src'];

/**
 * Reads the header lines above a `---` boundary: the exact `key: value` form,
 * the closed key set, the positional `type` first line, the alt rules and the
 * per-type header shape. Returns the parsed values, or the refusal as a string.
 */
export function parseFyRenderHeaders(lines: readonly string[]): FyRenderParsedHeaders | string {
  if (lines.length === 0) return 'Missing fy-render headers';
  const headers = new Map<string, string>();
  for (const line of lines) {
    const match = HEADER_LINE.exec(line);
    if (match === null) return 'Headers must use the exact "key: value" form, one per line';
    const key = match[1] ?? '';
    const value = match[2] ?? '';
    if (!HEADER_KEYS.includes(key)) return `Unknown fy-render header: ${key}`;
    if (headers.has(key)) return `Duplicate fy-render header: ${key}`;
    headers.set(key, value);
  }

  // THE FIRST LINE DECLARES THE TYPE, literally. A block is meant to be
  // identifiable from its opening line alone — by a reader scrolling, and by a
  // grep — so `type` is positional rather than merely present. This runs after
  // the loop so a malformed or unknown first line is reported as what it is.
  if (HEADER_LINE.exec(lines[0] ?? '')?.[1] !== 'type') return 'The first header line must declare type';

  // Present because the line above proved the first header line declared it;
  // there is deliberately no second "missing type" check to drift from that one.
  const type = headers.get('type') ?? '';
  const alt = headers.get('alt');
  const mime = headers.get('mime');
  const rawSrc = headers.get('src');
  if (!isFyRenderType(type)) return `Unknown fy-render type: ${type}`;
  if (alt === undefined) return 'Missing required alt header';
  if (alt.length === 0) return 'Alt text must not be empty';
  if (hasControlCharacter(alt)) return 'Alt text must be one line without control characters';
  if (characterLength(alt) > FY_RENDER_LIMITS.altCharacters) return 'Alt text exceeds 200 characters';
  const shape = headerShapeRefusal(type, mime, rawSrc);
  if (shape !== null) return shape;
  if (mime !== undefined && !isImageMime(mime)) return `Unsupported image MIME type: ${mime}`;
  return { type, alt, mime, src: rawSrc };
}

/** An element with an `on…` attribute: `<b onclick=…>`, `<svg/onload=…>`, in any case. */
const HANDLER_ATTRIBUTE = /<[a-z][^>]*[\s/]on[a-z]+\s*=/iu;

/**
 * WHETHER AN `html` BLOCK ASKS TO RUN, decided on the raw bytes before any sanitizer sees them.
 *
 * This is a ROUTE, not a gate: both answers are safe. A fragment that only looks static is still
 * sanitized and every handler stripped; one that only looks scripted runs in the opaque frame, which
 * is where author code is allowed to run anyway. So the test errs towards "runs" — a `<script` or a
 * handler-shaped attribute anywhere, comments and attribute values included — and never needs to
 * parse HTML to be right about safety.
 */
export const fyRenderHtmlRunsScript = (payload: string): boolean =>
  /<script[\s>/]/iu.test(payload) || HANDLER_ATTRIBUTE.test(payload);

/**
 * The whole `html` payload gate: a byte cap and nothing else. Everything that
 * makes an `html` block safe is a property of the SINK (sanitizer or opaque
 * frame, both in the PWA), never of a scan of the bytes — see the module header.
 */
export function validateHtml(payload: string): string | null {
  if (byteLength(payload) > FY_RENDER_LIMITS.htmlBytes) return 'HTML payload exceeds 200 KiB';
  return null;
}

/** Leading XML declarations, processing instructions, comments and whitespace. */
export const SVG_PROLOGUE = /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->)*/u;
/**
 * A LONE UTF-16 SURROGATE — text that is not a sequence of Unicode scalars.
 *
 * Under the `u` flag a well-formed surrogate PAIR is one code point and does not
 * match, so this finds exactly the unpaired halves. It is not a style rule: the
 * renderer builds an SVG's `data:` URL with `encodeURIComponent`, which THROWS
 * `URIError` on one, and a throw inside a transcript row takes the row with it.
 * Refusing it here keeps the never-throws contract where it belongs — at the
 * boundary — and costs an author nothing, because no SVG needs one.
 *
 * Exported with `SVG_PROLOGUE`, `scanSvg` and `svgCanvasRefusal` because the
 * PWA's compiled-Mermaid re-admission gate (`fyRenderMermaidSvg`) reads a
 * generated diagram through these same rules; a second copy of the scan there
 * would be a second answer to "what may reach an `<img>`".
 */
export const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * XML 1.0 `NameStartChar` (production [4]) — what actually begins an element.
 *
 * The first build scanned `[A-Za-z]`, so `<_/>`, `<:a/>` and `<À/>` were all
 * invisible to the element cap and roughly 25,000 of them fitted inside the byte
 * cap. Anything narrower than the real production is a cap in name only.
 */
function isNameStart(code: number): boolean {
  return (
    code === 0x3a ||
    code === 0x5f ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0xc0 && code <= 0xd6) ||
    (code >= 0xd8 && code <= 0xf6) ||
    (code >= 0xf8 && code <= 0x2ff) ||
    (code >= 0x370 && code <= 0x37d) ||
    (code >= 0x37f && code <= 0x1fff) ||
    (code >= 0x200c && code <= 0x200d) ||
    (code >= 0x2070 && code <= 0x218f) ||
    (code >= 0x2c00 && code <= 0x2fef) ||
    (code >= 0x3001 && code <= 0xd7ff) ||
    (code >= 0xf900 && code <= 0xfdcf) ||
    (code >= 0xfdf0 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0xeffff)
  );
}

/**
 * XML 1.0 `NameChar` (production [4a]) — the complete production, combining
 * marks included. Truncating a name early is not cosmetic: a QName cut short by
 * an unrecognised character reports the wrong local name, and the filter-primitive
 * count is taken from the local name.
 */
const isNameChar = (code: number): boolean =>
  isNameStart(code) ||
  code === 0x2d ||
  code === 0x2e ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0xb7 ||
  (code >= 0x300 && code <= 0x36f) ||
  (code >= 0x203f && code <= 0x2040);

/**
 * The element local names an SVG payload may not carry, in their canonical
 * spelling — which is the spelling every refusal message uses, whatever the
 * author wrote.
 *
 * `<use>` is on the list bluntly on purpose: a real answer is a reference-cycle
 * detector, and one is not worth building for a chat illustration.
 * `docs/fy-render.md` records that.
 */
const SVG_FORBIDDEN_ELEMENTS = ['script', 'foreignObject', 'use'] as const;

type SvgForbiddenElement = (typeof SVG_FORBIDDEN_ELEMENTS)[number];

/** The canonical forbidden name a scanned element name is, or null. */
function forbiddenElement(local: string): SvgForbiddenElement | null {
  const lowered = local.toLowerCase();
  return SVG_FORBIDDEN_ELEMENTS.find(name => name.toLowerCase() === lowered) ?? null;
}

export interface SvgScan {
  readonly elements: number;
  readonly filterPrimitives: number;
  /**
   * The FIRST forbidden element in document order, canonically spelled, or null
   * when there is none.
   *
   * BY LOCAL NAME AND CASE-INSENSITIVELY, for the same reason the filter
   * primitives are counted that way: when `svg` is bound to the SVG namespace,
   * a browser resolves `<svg:script>` as the element `script`, while an
   * unqualified `/<script[\s/>]/` regex reads it as ordinary text. This lexical
   * scan does not interpret namespace declarations; it conservatively applies
   * the local-name policy to every prefix. A prefix must not buy an author an
   * element the unprefixed spelling is refused for.
   */
  readonly forbidden: SvgForbiddenElement | null;
  /** The root `<svg …>` start tag, verbatim, quotes honoured. */
  readonly rootTag: string | null;
}

/**
 * Walks an SVG's markup once, lexically.
 *
 * A REGEX WOULD NOT DO. `/<[A-Za-z_…]/g` counts tag-like text inside comments
 * and CDATA, so the documented fact "element opening tags" would stop being
 * true, and `[^>]*` for the root tag stops at the first `>` — including one
 * inside a quoted attribute value, which hides every attribute after it. This
 * advances across comments, CDATA, processing instructions, declarations and
 * closing tags, and reads quoted attribute bodies properly, so a count is a
 * count of elements and the root tag is the whole root tag.
 *
 * The FORBIDDEN ELEMENTS are read here for the same reason: this walk already
 * resolves a QName to its local name, so `<svg:script>` is seen for what it is,
 * while the regex that used to decide it saw ordinary text.
 *
 * Returns null for an unterminated construct: a document whose comment never
 * closes has not been scanned, and an unscanned document is refused rather than
 * assumed small.
 */
export function scanSvg(source: string): SvgScan | null {
  let at = 0;
  let elements = 0;
  let filterPrimitives = 0;
  let forbidden: SvgForbiddenElement | null = null;
  let rootTag: string | null = null;

  /** The index just past `token`, or null when it never closes. */
  const skipTo = (from: number, token: string): number | null => {
    const end = source.indexOf(token, from);
    return end === -1 ? null : end + token.length;
  };

  while (at < source.length) {
    const open = source.indexOf('<', at);
    if (open === -1) break;

    if (source.startsWith('<!--', open)) {
      const next = skipTo(open + 4, '-->');
      if (next === null) return null;
      at = next;
      continue;
    }
    if (source.startsWith('<![CDATA[', open)) {
      const next = skipTo(open + 9, ']]>');
      if (next === null) return null;
      at = next;
      continue;
    }
    if (source.startsWith('<?', open)) {
      const next = skipTo(open + 2, '?>');
      if (next === null) return null;
      at = next;
      continue;
    }
    if (source.startsWith('<!', open) || source.startsWith('</', open)) {
      const next = skipTo(open + 2, '>');
      if (next === null) return null;
      at = next;
      continue;
    }

    const first = source.codePointAt(open + 1);
    if (first === undefined || !isNameStart(first)) {
      // A bare `<` in text content is not a tag.
      at = open + 1;
      continue;
    }

    // An element opening tag. Read its name, then find the `>` that is not
    // inside a quoted attribute value.
    let cursor = open + 1;
    while (cursor < source.length) {
      const code = source.codePointAt(cursor);
      if (code === undefined || !isNameChar(code)) break;
      cursor += code > 0xffff ? 2 : 1;
    }
    const name = source.slice(open + 1, cursor);

    let quote = '';
    let end = -1;
    for (let scan = cursor; scan < source.length; scan += 1) {
      const character = source[scan];
      if (quote !== '') {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '>') {
        end = scan;
        break;
      }
    }
    if (end === -1) return null;

    elements += 1;
    // BY LOCAL NAME. `<svg:feGaussianBlur>` is the same primitive as
    // `<feGaussianBlur>`, and a prefix must not buy an author extra ones — nor,
    // below, an element the unprefixed spelling is refused for.
    const local = name.slice(name.lastIndexOf(':') + 1);
    if (/^fe[A-Z]/u.test(local)) filterPrimitives += 1;
    forbidden ??= forbiddenElement(local);
    if (rootTag === null && local === 'svg') rootTag = source.slice(open, end + 1);
    at = end + 1;
  }

  return { elements, filterPrimitives, forbidden, rootTag };
}

/**
 * The value of one EXACT, unqualified attribute of a start tag.
 *
 * Exact and unqualified is the whole point: a word-boundary match reads
 * `data-width` and `x:width` as `width`, so an author could put a small decoy
 * first and an oversized real dimension after it and be measured on the decoy.
 * Names are compared by equality, and the tag is walked rather than matched.
 */
function rootAttribute(tag: string, name: string): string | null {
  let at = 1;
  while (at < tag.length && !/\s/u.test(tag[at] ?? '')) at += 1;
  while (at < tag.length) {
    while (at < tag.length && /[\s/]/u.test(tag[at] ?? '')) at += 1;
    const start = at;
    while (at < tag.length && !/[\s=/>]/u.test(tag[at] ?? '')) at += 1;
    const attribute = tag.slice(start, at);
    // The closing `>` yields an empty name, which is how the walk ends.
    if (attribute.length === 0) break;
    while (at < tag.length && /\s/u.test(tag[at] ?? '')) at += 1;
    if (tag[at] !== '=') {
      // A valueless attribute; keep walking rather than stopping.
      if (attribute === name) return '';
      continue;
    }
    at += 1;
    while (at < tag.length && /\s/u.test(tag[at] ?? '')) at += 1;
    const quote = tag[at];
    let value: string;
    if (quote === '"' || quote === "'") {
      const close = tag.indexOf(quote, at + 1);
      if (close === -1) return null;
      value = tag.slice(at + 1, close);
      at = close + 1;
    } else {
      const from = at;
      while (at < tag.length && !/[\s>]/u.test(tag[at] ?? '')) at += 1;
      value = tag.slice(from, at);
    }
    if (attribute === name) return value;
  }
  return null;
}

/** One declared length: a resolved pixel extent, a ratio, or unresolvable. */
type SvgLength = { readonly px: number } | { readonly percent: number } | null;

function parseSvgLength(raw: string | null): SvgLength {
  if (raw === null) return null;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(px|%)?$/iu.exec(raw.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return (match[2] ?? '').toLowerCase() === '%' ? { percent: value } : { px: value };
}

/** The `viewBox`'s extents, or null when it is absent, malformed or degenerate. */
function parseViewBox(tag: string): { readonly width: number; readonly height: number } | null {
  const raw = rootAttribute(tag, 'viewBox');
  if (raw === null) return null;
  const parts = raw
    .trim()
    .split(/[\s,]+/u)
    .filter(part => part.length > 0);
  if (parts.length !== 4) return null;
  const numbers = parts.map(Number);
  if (numbers.some(value => !Number.isFinite(value))) return null;
  const width = numbers[2] ?? 0;
  const height = numbers[3] ?? 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

const overCanvasBounds = (width: number, height: number): boolean =>
  width > FY_RENDER_LIMITS.maxDimension ||
  height > FY_RENDER_LIMITS.maxDimension ||
  width * height > FY_RENDER_LIMITS.maxPixels;

const CANVAS_LIMIT = `${FY_RENDER_LIMITS.maxDimension} per axis or ${FY_RENDER_LIMITS.maxPixels} total pixels`;

/**
 * Bounds the canvas the root element DECLARES.
 *
 * EVERY AXIS IS RESOLVED INDEPENDENTLY and then both are checked together. An
 * earlier draft accepted the pair as soon as it saw a valid percentage, so
 * `width="100%" height="999999px"` behind a small `viewBox` passed on the
 * strength of the axis that was fine. A per-axis resolution has no such short
 * circuit: a percentage resolves against the (already bounded) `viewBox`, a
 * length resolves to itself, and anything else is unresolvable and refused.
 *
 * This bounds the CANVAS, not the cost of painting it. A bounded canvas can
 * still be expensive to rasterise, which is why nothing here may be described as
 * a resource boundary — see `docs/fy-render.md`.
 */
export function svgCanvasRefusal(tag: string): string | null {
  const viewBox = parseViewBox(tag);
  if (viewBox !== null && overCanvasBounds(viewBox.width, viewBox.height)) return `SVG viewBox exceeds ${CANVAS_LIMIT}`;

  /**
   * ONE AXIS AT A TIME, and an omitted axis is not a reason to stop reading.
   *
   * An earlier draft returned as soon as EITHER axis was missing behind a
   * viewBox, so `width="999999" viewBox="0 0 10 10"` and `width="999%"` with the
   * height left out were both accepted on the strength of the axis that was not
   * there. Omission may only ever mean "inherit the bounded viewBox extent"; it
   * may never excuse the axis that IS declared.
   */
  const axis = (declared: string | null, extent: number | undefined): number | string => {
    if (declared === null) {
      // Nothing to read: the viewBox is the only thing that can bound it.
      return extent ?? 'SVG must declare width and height, or a bounded viewBox';
    }
    const length = parseSvgLength(declared);
    if (length === null) return 'SVG width and height must be unitless, px, or a percentage';
    if ('px' in length) return length.px > 0 ? length.px : 'SVG width and height must be positive';
    if (extent === undefined) return 'SVG percentage dimensions require a bounded viewBox';
    if (length.percent <= 0 || length.percent > 100)
      return 'SVG percentage dimensions must be above 0% and at most 100%';
    return (length.percent / 100) * extent;
  };

  const width = axis(rootAttribute(tag, 'width'), viewBox?.width);
  if (typeof width === 'string') return width;
  const height = axis(rootAttribute(tag, 'height'), viewBox?.height);
  if (typeof height === 'string') return height;
  if (overCanvasBounds(width, height)) return `SVG canvas exceeds ${CANVAS_LIMIT}`;
  return null;
}

/**
 * Bounds an SVG payload, best-effort, before it is handed to an `<img>`.
 *
 * WHAT THIS DOES NOT DO: it does not parse the document, so it does not prove
 * well-formedness and it does not prove there is exactly ONE root element. It
 * proves the payload BEGINS with an `<svg>` element and stays inside the size
 * and shape caps. That is deliberate — the alternative is a `DOMParser` here,
 * and this module is shared with the daemon and the CLI, which have no DOM to
 * parse with; the renderer already establishes the structural fact better. The
 * real well-formedness check is the browser's own parser at decode time, and
 * its failure is visible: a payload it refuses fires `<img>`'s `error` event
 * and the block renders its error fallback with the source. Do not describe
 * this function as validating a single well-formed root.
 *
 * The rejections below are authoring policy and defence in depth. They are
 * bypassable, and they are NOT what makes a payload safe — a probe confirmed the
 * `<img>` sink neutralises `<use>`, `<foreignObject>` and `<script>` on its own,
 * and equally neutralises a dozen constructs this function waves straight
 * through. Read a refusal here as "this will not do what you think", never as
 * "this would otherwise have been unsafe".
 *
 * The forbidden elements are nonetheless decided by the LEXICAL SCAN rather than
 * by a `/<script[\s/>]/` regex, because a policy that reads `<script>` as a
 * script and `<svg:script>` as text is not stating a policy at all. See
 * `SvgScan.forbidden`.
 */
export function validateSvg(payload: string): string | null {
  if (byteLength(payload) > FY_RENDER_LIMITS.svgBytes) return 'SVG payload exceeds 100 KiB';
  // Before anything else that reads the text: this one is about the RENDERER not
  // throwing, not about the payload being sensible. See `LONE_SURROGATE`.
  if (LONE_SURROGATE.test(payload)) return 'SVG payload contains an unpaired UTF-16 surrogate';
  // Entity expansion makes parse cost a function of declarations rather than of
  // the bounded source bytes, which is the one way a size cap stops being one.
  if (/<!DOCTYPE|<!ENTITY/iu.test(payload)) return 'SVG document type and entity declarations are not accepted';
  const body = payload.replace(SVG_PROLOGUE, '');
  if (!/^<svg[\s/>]/u.test(body)) return 'SVG payload must begin with an <svg> element';

  const scan = scanSvg(payload);
  if (scan === null) return 'SVG payload has an unterminated comment, CDATA section or tag';
  if (scan.forbidden !== null) return `SVG <${scan.forbidden}> elements are not accepted`;
  if (scan.elements > FY_RENDER_LIMITS.svgElements)
    return `SVG payload exceeds ${FY_RENDER_LIMITS.svgElements} elements`;
  if (scan.filterPrimitives > FY_RENDER_LIMITS.svgFilterPrimitives)
    return `SVG payload exceeds ${FY_RENDER_LIMITS.svgFilterPrimitives} filter primitives`;
  if (scan.rootTag === null) return 'SVG root element start tag could not be read';
  return svgCanvasRefusal(scan.rootTag);
}
