/**
 * The single grammar owner for conversation-only `fy-render` fences.
 *
 * NOTHING HERE EXECUTES A PAYLOAD. This module is a pure string reader: it
 * turns a fence body into a validated description of what an author asked for,
 * or into a refusal with a human-readable reason. It has no DOM dependency, no
 * timer, no network call, and no side effect, which is why it can be the one
 * place both the renderer and the documentation read their numbers from.
 *
 * THIS BUILD RENDERS TWO TYPES AND SHOWS THE REST AS SOURCE. `svg` and `image`
 * become an `<img>`; `html`, `mermaid` and `lottie` are parsed, bounded, and
 * then rendered as their own escaped text. That is a deliberate, declared
 * limitation rather than an oversight — see `docs/fy-render.md`, which records
 * the evidence for why executable rendering is not in this build.
 *
 * THE VALIDATION HERE IS A BOUND, NOT A SANITISER, and not a promise of a
 * precise refusal either. It rejects a few obviously unsupported constructs and
 * caps how much work a parser can be made to do. It does NOT enumerate what an
 * SVG may contain: external image, font, stylesheet and paint references, SMIL,
 * `onload`/`onerror` attributes and `javascript:` anchors are all ACCEPTED here
 * and simply render inert or incomplete. Measured, not assumed — a real-Chromium
 * probe put 15 of 25 hostile payloads straight through these checks and every
 * one of them was harmless because of the SINK, not because of the scan.
 *
 * THE SINK IS THE SECURITY BOUNDARY, and it is exactly one thing: an authored
 * SVG reaches the page only as the `src` of an HTML `<img>`, as a
 * `data:image/svg+xml,…` URL. In that image-document mode, Chrome 150 was
 * measured to suppress script and script event handlers and every external
 * subresource load. The same bytes in an active top-level SVG document fetched,
 * executed and navigated, so the claim belongs to the sink and not to the bytes.
 * Do NOT generalise it to inline SVG, `<object>`, `<embed>`, `<iframe>`, a CSS
 * image or paint consumer, or a blob URL used for anything else. It does NOT say
 * declarative animation is inert — SMIL and CSS animation are a different
 * capability and were not claimed either way. Firefox, WebKit and Safari are
 * UNMEASURED. `docs/fy-render.md` cites the ledger.
 *
 * So: weakening a check here is an authoring-feedback regression; changing where
 * these bytes are consumed is a security regression.
 */

/** The fence info string that opts a block into this grammar, and nothing else. */
export const FY_RENDER_FENCE_LANGUAGE = 'fy-render';

/** The attribute `remarkFyRenderFences` stamps, and the only mark the renderer trusts. */
export const FY_RENDER_FENCE_ATTRIBUTE = 'data-fy-render-fence';

/**
 * Minimal structural mdast, in the same spirit as `remark-table-labels.ts`: only
 * the fields a `code` node actually exposes, so the full mdast typings stay a
 * transitive detail rather than a direct dependency.
 */
interface MdNode {
  type: string;
  lang?: string | null;
  meta?: string | null;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/**
 * remark plugin: mark the fences whose info string is EXACTLY `fy-render`.
 *
 * WHY A PLUGIN AND NOT A CLASS-NAME TEST. mdast splits a fence's info string
 * into `lang` and `meta`, and `mdast-util-to-hast` renders only `lang` into
 * `class="language-…"`. A fence opened as `fy-render notes` therefore arrives in
 * hast wearing `language-fy-render` and its metadata gone — indistinguishable
 * downstream from the real thing. The exactness the contract promises has to be
 * decided where both halves are still visible, which is here.
 *
 * The mark rides `data.hProperties`, the mdast→hast contract, so it reaches the
 * rendered element with no DOM walking — the same mechanism `data-label` uses.
 */
const markFences = (node: MdNode): void => {
  // `meta` is everything after the language token. Anything at all there means a
  // different fence, so `fy-render notes` and `fy-render {x}` both stay ordinary.
  if (node.type === 'code' && node.lang === FY_RENDER_FENCE_LANGUAGE && (node.meta ?? '') === '') {
    node.data ??= {};
    node.data.hProperties ??= {};
    node.data.hProperties[FY_RENDER_FENCE_ATTRIBUTE] = 'true';
  }
  // A fence can sit at any depth — inside a list item or a blockquote — so the
  // walk is full rather than a scan of the root's own children.
  for (const child of node.children ?? []) markFences(child);
};

export const remarkFyRenderFences = () => markFences;

export const FY_RENDER_TYPES = ['html', 'svg', 'lottie', 'mermaid', 'image'] as const;
export type FyRenderType = (typeof FY_RENDER_TYPES)[number];

/**
 * Every cap in one place, so the renderer, the tests and `docs/fy-render.md`
 * cannot drift into quoting three different numbers for the same limit.
 */
export const FY_RENDER_LIMITS = {
  altCharacters: 200,
  htmlBytes: 200 * 1024,
  svgBytes: 100 * 1024,
  svgElements: 500,
  mermaidCharacters: 20_000,
  lottieBytes: 1024 * 1024,
  lottieLayers: 500,
  lottieDepth: 64,
  imageBytes: 2 * 1024 * 1024,
  /** How much authored source the source panel prints before it truncates. */
  sourcePreviewCharacters: 32 * 1024,
} as const;

/**
 * Raster MIME types only. `image/svg+xml` is deliberately absent: an author who
 * wants an SVG uses `type: svg` and gets the SVG checks, rather than routing a
 * vector payload past them through a MIME string.
 */
export const FY_RENDER_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const;
export type FyRenderImageMime = (typeof FY_RENDER_IMAGE_MIMES)[number];

interface FyRenderBaseBlock<TType extends FyRenderType> {
  readonly type: TType;
  /** The required accessible description. Never empty; never multi-line. */
  readonly alt: string;
  /** Payload bytes after the `---` boundary, verbatim except where a type
   *  normalises them (`image` strips base64 whitespace). */
  readonly payload: string;
  /** The whole fence body as authored, which is what the source panel prints. */
  readonly source: string;
}

export type FyRenderBlock =
  | FyRenderBaseBlock<'html'>
  | FyRenderBaseBlock<'svg'>
  | FyRenderBaseBlock<'lottie'>
  | FyRenderBaseBlock<'mermaid'>
  | (FyRenderBaseBlock<'image'> & { readonly mime: FyRenderImageMime });

export type FyRenderParseResult =
  | { readonly ok: true; readonly block: FyRenderBlock }
  | { readonly ok: false; readonly reason: string };

/**
 * How a block is presented in THIS build.
 *
 * `visual` types reach an `<img>`; `source` types are printed as escaped text
 * with the limitation stated on screen. The switch is exhaustive on purpose: a
 * sixth type is a compile error here rather than a silent fallthrough into
 * whichever branch happens to be last.
 */
export function fyRenderPresentation(type: FyRenderType): 'visual' | 'source' {
  switch (type) {
    case 'svg':
    case 'image':
      return 'visual';
    case 'html':
    case 'mermaid':
    case 'lottie':
      return 'source';
  }
}

const UTF8 = new TextEncoder();
const HEADER_LINE = /^([a-z]+): (.*)$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const WHITESPACE = /\s+/gu;
/** An element open tag: `<` immediately followed by a name character. */
const ELEMENT_OPEN = /<[A-Za-z]/gu;
/** Leading XML declarations, processing instructions, comments and whitespace. */
const SVG_PROLOGUE = /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->)*/u;
/**
 * A LONE UTF-16 SURROGATE — text that is not a sequence of Unicode scalars.
 *
 * Under the `u` flag a well-formed surrogate PAIR is one code point and does not
 * match, so this finds exactly the unpaired halves. It is not a style rule: the
 * renderer builds an SVG's `data:` URL with `encodeURIComponent`, which THROWS
 * `URIError` on one, and a throw inside a transcript row takes the row with it.
 * Refusing it here keeps the never-throws contract where it belongs — at the
 * boundary — and costs an author nothing, because no SVG needs one.
 */
const LONE_SURROGATE = /\p{Surrogate}/u;

const fail = (reason: string): FyRenderParseResult => ({ ok: false, reason });
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
const isImageMime = (value: string): value is FyRenderImageMime => FY_RENDER_IMAGE_MIMES.some(mime => mime === value);

const countMatches = (value: string, pattern: RegExp): number => value.match(pattern)?.length ?? 0;

/**
 * Bounds an SVG payload, best-effort, before it is handed to an `<img>`.
 *
 * WHAT THIS DOES NOT DO: it does not parse the document, so it does not prove
 * well-formedness and it does not prove there is exactly ONE root element. It
 * proves the payload BEGINS with an `<svg>` element and stays inside the size
 * and shape caps. That is deliberate — the alternative is a `DOMParser` here,
 * and this module is the domain tier: no other `src/lib` module in this package
 * touches the DOM, and buying a structural check with the first one would be a
 * poor trade for a fact the renderer already establishes better. The real
 * well-formedness check is the browser's own parser at decode time, and its
 * failure is visible: a payload it refuses fires `<img>`'s `error` event and the
 * block renders its error fallback with the source. Do not describe this
 * function as validating a single well-formed root.
 *
 * The four rejections below are authoring policy and defence in depth. They are
 * a plain string scan, they are bypassable, and they are NOT what makes a
 * payload safe — a probe confirmed the `<img>` sink neutralises `<use>`,
 * `<foreignObject>` and `<script>` on its own, and equally neutralises a dozen
 * constructs this function waves straight through. Read a refusal here as "this
 * will not do what you think", never as "this would otherwise have been unsafe".
 */
function validateSvg(payload: string): string | null {
  if (byteLength(payload) > FY_RENDER_LIMITS.svgBytes) return 'SVG payload exceeds 100 KiB';
  // Before anything else that reads the text: this one is about the RENDERER not
  // throwing, not about the payload being sensible. See `LONE_SURROGATE`.
  if (LONE_SURROGATE.test(payload)) return 'SVG payload contains an unpaired UTF-16 surrogate';
  // Entity expansion makes parse cost a function of declarations rather than of
  // the bounded source bytes, which is the one way a size cap stops being one.
  if (/<!DOCTYPE|<!ENTITY/iu.test(payload)) return 'SVG document type and entity declarations are not accepted';
  const body = payload.replace(SVG_PROLOGUE, '');
  if (!/^<svg[\s/>]/u.test(body)) return 'SVG payload must begin with an <svg> element';
  if (/<script[\s/>]/iu.test(payload)) return 'SVG <script> elements are not accepted';
  if (/<foreignObject[\s/>]/iu.test(payload)) return 'SVG <foreignObject> elements are not accepted';
  // Blunt on purpose: a real answer is a reference-cycle detector, and one is
  // not worth building for a chat illustration. `docs/fy-render.md` records it.
  if (/<use[\s/>]/iu.test(payload)) return 'SVG <use> elements are not accepted';
  if (countMatches(payload, ELEMENT_OPEN) > FY_RENDER_LIMITS.svgElements) return 'SVG payload exceeds 500 elements';
  return null;
}

interface LottieScan {
  readonly layers: number;
  readonly expression: boolean;
  readonly tooDeep: boolean;
}

/**
 * Counts layers and refuses expression keys at any depth.
 *
 * Lottie's `"x"` key carries a JavaScript expression that a full player will
 * evaluate. Nothing in this build hands a payload to a player, so this is a
 * forward guarantee rather than a live defence: the grammar refuses the shape
 * now, so a later build that does render Lottie cannot inherit an accepted
 * corpus containing it.
 */
function scanLottie(value: unknown, depth: number): LottieScan {
  if (value === null || typeof value !== 'object') return { layers: 0, expression: false, tooDeep: false };
  if (depth > FY_RENDER_LIMITS.lottieDepth) return { layers: 0, expression: false, tooDeep: true };
  let layers = 0;
  if (Array.isArray(value)) {
    for (const child of value) {
      const scan = scanLottie(child, depth + 1);
      layers += scan.layers;
      if (scan.expression || scan.tooDeep) return { layers, expression: scan.expression, tooDeep: scan.tooDeep };
    }
    return { layers, expression: false, tooDeep: false };
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'x') return { layers, expression: true, tooDeep: false };
    if (key === 'layers' && Array.isArray(child)) layers += child.length;
    const scan = scanLottie(child, depth + 1);
    layers += scan.layers;
    if (scan.expression || scan.tooDeep) return { layers, expression: scan.expression, tooDeep: scan.tooDeep };
  }
  return { layers, expression: false, tooDeep: false };
}

function validateLottie(payload: string): string | null {
  if (byteLength(payload) > FY_RENDER_LIMITS.lottieBytes) return 'Lottie payload exceeds 1 MiB';
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return 'Lottie payload is not valid JSON';
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object')
    return 'Lottie payload must be a JSON object';
  const scan = scanLottie(parsed, 0);
  if (scan.expression) return 'Lottie expression keys are not accepted';
  if (scan.tooDeep) return 'Lottie payload exceeds 64 levels of nesting';
  if (scan.layers > FY_RENDER_LIMITS.lottieLayers) return 'Lottie payload exceeds 500 layers';
  return null;
}

/**
 * The decoded byte length of canonical base64, or null when the text is not
 * canonical base64 at all. Authored payloads are line-wrapped, so whitespace is
 * removed by the caller before this sees them.
 */
function decodedBase64Bytes(payload: string): number | null {
  if (payload.length === 0 || !BASE64.test(payload)) return null;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
}

interface FyRenderHeaders {
  readonly type: FyRenderType;
  readonly alt: string;
  readonly mime: FyRenderImageMime | undefined;
}

function parseHeaders(lines: readonly string[]): FyRenderHeaders | string {
  if (lines.length === 0) return 'Missing fy-render headers';
  const headers = new Map<string, string>();
  for (const line of lines) {
    const match = HEADER_LINE.exec(line);
    if (match === null) return 'Headers must use the exact "key: value" form, one per line';
    const key = match[1] ?? '';
    const value = match[2] ?? '';
    if (key !== 'type' && key !== 'alt' && key !== 'mime') return `Unknown fy-render header: ${key}`;
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
  if (!isFyRenderType(type)) return `Unknown fy-render type: ${type}`;
  if (alt === undefined) return 'Missing required alt header';
  if (alt.length === 0) return 'Alt text must not be empty';
  if (hasControlCharacter(alt)) return 'Alt text must be one line without control characters';
  if (characterLength(alt) > FY_RENDER_LIMITS.altCharacters) return 'Alt text exceeds 200 characters';
  if (type === 'image' && mime === undefined) return 'Image blocks require a mime header';
  if (type !== 'image' && mime !== undefined) return 'The mime header is only valid for image blocks';
  if (mime !== undefined && !isImageMime(mime)) return `Unsupported image MIME type: ${mime}`;
  return { type, alt, mime };
}

/**
 * The one type whose payload is normalised rather than kept verbatim: authored
 * base64 is line-wrapped, and the canonical form is what the renderer puts in the
 * data URL. `source` still holds the bytes exactly as typed, for the source panel.
 *
 * Lifted out of the `switch` rather than written inline because a `case` block's
 * closing brace is a line Bun's coverage counts and nothing can execute — every
 * path inside returns — so an inline block leaves the unit ledger one line short
 * of 100% on code that is not there.
 */
function parseImageBlock(alt: string, mime: FyRenderImageMime, payload: string, source: string): FyRenderParseResult {
  const compact = payload.replace(WHITESPACE, '');
  const decoded = decodedBase64Bytes(compact);
  if (decoded === null) return fail('Image payload must be canonical base64');
  if (decoded > FY_RENDER_LIMITS.imageBytes) return fail('Image payload exceeds 2 MiB decoded');
  return { ok: true, block: { type: 'image', alt, mime, payload: compact, source } };
}

/**
 * Reads one fence body. Never throws, never executes, never reaches the network:
 * every failure is an `ok: false` reason the caller renders as an ordinary
 * escaped fence.
 */
export function parseFyRender(source: string): FyRenderParseResult {
  const lines = source.split('\n');
  const boundary = lines.indexOf('---');
  if (boundary === -1) return fail('Missing the exact --- boundary line between headers and payload');

  const headers = parseHeaders(lines.slice(0, boundary));
  if (typeof headers === 'string') return fail(headers);
  const { type, alt, mime } = headers;

  const payload = lines.slice(boundary + 1).join('\n');
  switch (type) {
    case 'html': {
      if (byteLength(payload) > FY_RENDER_LIMITS.htmlBytes) return fail('HTML payload exceeds 200 KiB');
      return { ok: true, block: { type, alt, payload, source } };
    }
    case 'svg': {
      const reason = validateSvg(payload);
      return reason === null ? { ok: true, block: { type, alt, payload, source } } : fail(reason);
    }
    case 'mermaid': {
      if (characterLength(payload) > FY_RENDER_LIMITS.mermaidCharacters)
        return fail('Mermaid payload exceeds 20,000 characters');
      return { ok: true, block: { type, alt, payload, source } };
    }
    case 'lottie': {
      const reason = validateLottie(payload);
      return reason === null ? { ok: true, block: { type, alt, payload, source } } : fail(reason);
    }
    // `mime` is present for every `image` block: `parseHeaders` refuses one
    // without it, and refuses one on any other type.
    case 'image':
      return parseImageBlock(alt, mime as FyRenderImageMime, payload, source);
  }
}
