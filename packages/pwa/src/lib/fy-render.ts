/**
 * The single grammar owner for conversation-only `fy-render` fences.
 *
 * NOTHING HERE EXECUTES A PAYLOAD. This module is a pure string reader: it
 * turns a fence body into a validated description of what an author asked for,
 * or into a refusal with a human-readable reason. It has no DOM dependency, no
 * timer, no network call, and no side effect, which is why it can be the one
 * place both the renderer and the documentation read their numbers from.
 *
 * FOUR WAYS A BLOCK RENDERS. `svg` and inline `image` become an `<img>`
 * directly. `mermaid` and `lottie` are handed as DATA to a trusted library
 * running inside an opaque-origin sandbox frame — Mermaid compiles to an SVG
 * which is re-admitted through `fyRenderMermaidSvg` and then reaches the same
 * `<img>` sink, Lottie plays live inside the frame. `html` is a STATIC FRAGMENT:
 * sanitized by DOMPurify against a strict allowlist and rendered into a closed
 * shadow root (`fy-render-fragment.tsx`) — no script, no handler, no frame, no
 * remote load. `image`, `video`, `audio` and `pdf`
 * with a `src:` header name bytes that live somewhere else — the session's
 * workspace or an https URL — and carry no payload at all.
 *
 * `map` and `chart` are drawn in this document from a payload that is DATA — a
 * map description, a chart description — by a bundled library; nothing an
 * author wrote is code there either.
 *
 * `html` DOES NOT RUN, by the owner's decision: an interactive page in an opaque
 * frame could still self-navigate, prerender and open WebRTC, and a fragment
 * cannot. Nothing in THIS module runs anything either.
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

import { FY_RENDER_LIMITS, FY_RENDER_SANDBOX_LIMITS } from './fy-render-bounds.ts';
import { PALETTE_KEY } from './fy-render-palette.ts';
import { parseReferenceToken } from './references.ts';

export { FY_RENDER_LIMITS, FY_RENDER_SANDBOX_LIMITS };

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

export const FY_RENDER_TYPES = [
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
] as const;
export type FyRenderType = (typeof FY_RENDER_TYPES)[number];

/** The types a `src:` header may name, and the only ones it may appear on. */
export const FY_RENDER_MEDIA_TYPES = ['image', 'video', 'audio', 'pdf'] as const;
export type FyRenderMediaType = (typeof FY_RENDER_MEDIA_TYPES)[number];

/**
 * Where a media block's bytes live, and nothing else.
 *
 * `workspace` is an `@path` written and parsed exactly as an `@file` reference
 * is (`parseReferenceToken`), minus a line suffix — a picture has no line 12.
 * It is resolved against the session's folder at read time, by the reader's own
 * grants, never here. `media` is `media:<path>`: a file in the session's MEDIA
 * folder (`FY_MEDIA_DIR`), where an agent puts what it made to show the person —
 * outside any repository, so no ignore rule decides whether it can be shown, and
 * read by the same grant. `https` is a URL the reader's browser fetches once the
 * block is near. Nothing else: no `http:`, no `data:`, no `blob:`, no daemon
 * URL, because each of those is either a downgrade, a second inline grammar, or a
 * credential-shaped address.
 */
export type FyRenderSource =
  | { readonly kind: 'workspace'; readonly path: string }
  | { readonly kind: 'media'; readonly path: string }
  | { readonly kind: 'https'; readonly url: string };

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

/**
 * A block whose bytes live elsewhere. Its `payload` is always empty — the
 * grammar refuses one with content — so nothing below may treat it as data.
 */
export type FyRenderMediaBlock = FyRenderBaseBlock<FyRenderMediaType> & { readonly src: FyRenderSource };

export type FyRenderBlock =
  | FyRenderBaseBlock<'html'>
  | FyRenderBaseBlock<'svg'>
  | FyRenderBaseBlock<'lottie'>
  | FyRenderBaseBlock<'mermaid'>
  | FyRenderBaseBlock<'map'>
  | FyRenderBaseBlock<'chart'>
  | (FyRenderBaseBlock<'image'> & { readonly mime: FyRenderImageMime; readonly src?: undefined })
  | FyRenderMediaBlock;

export type FyRenderParseResult =
  | { readonly ok: true; readonly block: FyRenderBlock }
  | { readonly ok: false; readonly reason: string };

/** True for a block that names its bytes with `src:` rather than carrying them. */
export const isFyRenderMediaBlock = (block: FyRenderBlock): block is FyRenderMediaBlock =>
  'src' in block && block.src !== undefined;

/**
 * How a block is presented.
 *
 * `visual` blocks reach an `<img>` directly. `sandbox` blocks are interpreted by
 * a trusted library inside the opaque sandbox frame — Mermaid compiles to an SVG
 * that then reaches the same `<img>` sink, Lottie plays live inside the frame.
 * `fragment` is `html` WITHOUT script: static markup, sanitized and rendered in
 * a closed shadow root, where nothing an author wrote runs. `interactive` is `html`
 * WITH script — any `<script>` or `on…=` handler, found before anything is
 * sanitized — and runs in its own opaque-origin frame on its own static shell
 * (`fy-render-html-frame.tsx`). `media` is any block with a `src:` — its bytes
 * are read or fetched once the block is near. `map` is a Leaflet map built from a small JSON or YAML
 * description, in this document, from DOM nodes the engine creates — the author's bytes are data, never
 * markup (`fy-render-map.tsx`). `chart` is the same shape for a chart: a small JSON or YAML description in
 * this package's own chart language, drawn by Chart.js on a canvas in this document in the theme's colours
 * (`fy-render-chart.tsx`) — data again, never code.
 *
 * Decided by the BLOCK rather than the type, because `image` is two things: an
 * inline base64 payload that is admitted at parse time, and a `src:` whose
 * bytes do not exist yet. The switch is exhaustive on purpose: a new type is a
 * compile error here rather than a silent fallthrough into the last branch.
 */
export function fyRenderPresentation(
  block: FyRenderBlock,
): 'visual' | 'sandbox' | 'fragment' | 'interactive' | 'media' | 'map' | 'chart' {
  if (isFyRenderMediaBlock(block)) return 'media';
  switch (block.type) {
    case 'svg':
    case 'image':
      return 'visual';
    case 'mermaid':
    case 'lottie':
      return 'sandbox';
    case 'map':
      return 'map';
    case 'chart':
      return 'chart';
    case 'html':
      return fyRenderHtmlRunsScript(block.payload) ? 'interactive' : 'fragment';
  }
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

const UTF8 = new TextEncoder();
const HEADER_LINE = /^([a-z]+): (.*)$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const WHITESPACE = /\s+/gu;
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

interface SvgScan {
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
function scanSvg(source: string): SvgScan | null {
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
function svgCanvasRefusal(tag: string): string | null {
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

interface LottieScan {
  readonly layers: number;
  readonly expression: boolean;
  readonly tooDeep: boolean;
}

/**
 * An `"x"` that carries CODE rather than a number.
 *
 * Lottie overloads the key badly. As a JavaScript expression it is a STRING that
 * a full player compiles and runs — that is the thing this grammar exists to
 * refuse. Its other uses are not one shape but several: a bezier easing handle
 * is a number or an array of numbers (`{"i":{"x":[0.833],"y":[0.833]}}`), and a
 * separated-dimension position carries a whole animated property OBJECT under
 * `x` alongside its `y`. What they share is only that none of them is source
 * text.
 *
 * Slice A refused the key outright, which was safe and cost nothing while no
 * player existed. Measured against a real animation once one did, it rejected a
 * plain two-keyframe ease with "Lottie expression keys are not accepted" — so
 * the blunt rule would have shipped a Lottie type that refuses most real Lottie.
 * Refusing only string-valued `x` keeps every expression refused, because an
 * expression is always source text, and does not soften the defence: nothing
 * that is not a string can be compiled, and `lottie_light` registers no
 * evaluator to compile it with even if it were.
 *
 * An array is checked member-wise rather than by its first element: an
 * expression hidden at any index is still an expression.
 */
const isLottieExpression = (value: unknown): boolean =>
  typeof value === 'string' || (Array.isArray(value) && value.some(item => typeof item === 'string'));

/**
 * Counts layers and refuses expression keys at any depth.
 *
 * This is one of two independent refusals. The other is the shipped player: the
 * `lottie_light` build registers no expression plugin at all, so even a payload
 * that slipped past this scan would find nothing to evaluate it. Either alone
 * would be a single point of failure.
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
    if (key === 'x' && isLottieExpression(child)) return { layers, expression: true, tooDeep: false };
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
  readonly src: FyRenderSource | undefined;
}

const HEADER_KEYS: readonly string[] = ['type', 'alt', 'mime', 'src'];
/** The session media folder's `src:` prefix — see `FyRenderSource`. */
const MEDIA_PREFIX = 'media:';
const isMediaType = (type: FyRenderType): type is FyRenderMediaType =>
  FY_RENDER_MEDIA_TYPES.some(media => media === type);

/**
 * One `src:` value, or the reason it is not one.
 *
 * `@path` IS AN `@file` REFERENCE, parsed by the reference grammar's own token
 * reader rather than a second pattern here, so a path a reader can open from
 * prose is exactly a path a block can show — and nothing else is. A line suffix
 * is refused: it is meaningful for source code and meaningless for a picture.
 *
 * `https://` is parsed by the platform's URL parser and held to the scheme,
 * because `http:` would be a downgrade inside an https app and every other
 * scheme is either a second inline grammar (`data:`), a page-local handle
 * (`blob:`) or something that is not a fetch at all. Userinfo is refused: a URL
 * carrying `user:pass@` is a credential written into a transcript.
 */
function parseSource(value: string): FyRenderSource | string {
  if (characterLength(value) > FY_RENDER_LIMITS.srcCharacters)
    return `The src header exceeds ${FY_RENDER_LIMITS.srcCharacters} characters`;
  if (value.startsWith('@')) {
    const reference = parseReferenceToken(value);
    if (reference?.kind !== 'file' || reference.line !== undefined)
      return 'A workspace src must be an @path to a file, without a line number';
    return { kind: 'workspace', path: reference.path };
  }
  if (value.startsWith(MEDIA_PREFIX)) {
    const path = value.slice(MEDIA_PREFIX.length);
    // A name inside the folder, nothing that could leave it. The daemon refuses these too; refusing them
    // here means a bad block is an ordinary fence rather than a request that was always going to fail.
    if (
      path === '' ||
      path.startsWith('/') ||
      /[\s\\]/u.test(path) ||
      hasControlCharacter(path) ||
      path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
    )
      return 'A media src must be media:<file> inside the session media folder';
    return { kind: 'media', path };
  }
  if (!value.startsWith('https://')) return 'The src header must be an @path, media:<file> or an https:// URL';
  if (/\s/u.test(value) || hasControlCharacter(value)) return 'The src URL must not contain whitespace';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'The src URL could not be parsed';
  }
  if (url.username !== '' || url.password !== '') return 'The src URL must not carry a user name or password';
  return { kind: 'https', url: url.href };
}

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

function parseHeaders(lines: readonly string[]): FyRenderHeaders | string {
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
  const src = rawSrc === undefined ? undefined : parseSource(rawSrc);
  if (typeof src === 'string') return src;
  return { type, alt, mime, src };
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
const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number): number => ((b[at + 1] ?? 0) << 8) | (b[at] ?? 0);
const u24le = (b: Uint8Array, at: number): number => ((b[at + 2] ?? 0) << 16) | ((b[at + 1] ?? 0) << 8) | (b[at] ?? 0);
const u32le = (b: Uint8Array, at: number): number =>
  (((b[at + 3] ?? 0) << 24) | ((b[at + 2] ?? 0) << 16) | ((b[at + 1] ?? 0) << 8) | (b[at] ?? 0)) >>> 0;
const u32be = (b: Uint8Array, at: number): number =>
  (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>> 0;
const marks = (b: Uint8Array, at: number, text: string): boolean =>
  [...text].every((character, index) => b[at + index] === character.charCodeAt(0));

interface RasterHeader {
  readonly mime: FyRenderImageMime;
  readonly width: number;
  readonly height: number;
  /** True when the container declares more than one frame. */
  readonly animated: boolean;
}

/**
 * PNG: signature, `IHDR`, then a chunk walk for `acTL` — the chunk that makes a
 * PNG an APNG. This slice offers no Pause control, so it must not accept an
 * animation it cannot stop.
 */
function readPng(b: Uint8Array): RasterHeader | null {
  if (!marks(b, 0, '\x89PNG\r\n\x1a\n') || b.length < 24) return null;
  // The first chunk must be a well-formed IHDR — length 13, by the spec.
  if (!marks(b, 12, 'IHDR') || u32be(b, 8) !== 13) return null;
  let at = 8;
  let animated = false;
  let complete = false;
  let headers = 0;
  let dataRuns = 0;
  let inData = false;
  while (at + 12 <= b.length) {
    const length = u32be(b, at);
    // Subtraction, never addition: `at + 12 + length` can wrap for a u32 length.
    if (length > b.length - at - 12) return null;
    // A SECOND IHDR IS NOT A PNG. Reading the first and walking past a later,
    // contradictory one lets a 1×1 decoy set the dimension bound for a file that
    // also declares 16384×1. A chunk that must be unique is refused when repeated.
    if (marks(b, at + 4, 'IHDR')) {
      headers += 1;
      if (headers > 1) return null;
    }
    if (marks(b, at + 4, 'acTL')) animated = true;
    // IDAT chunks are consecutive by the specification. Counting RUNS rather than
    // chunks means a second run — image data restarting after something else —
    // is refused, which is the conservative reading of an ambiguous container.
    if (marks(b, at + 4, 'IDAT')) {
      if (!inData) dataRuns += 1;
      inData = true;
    } else {
      inData = false;
    }
    if (marks(b, at + 4, 'IEND')) {
      // IEND is empty and terminal, and a PNG with no image data at all is a
      // shell rather than an image: a signature, a header and an end marker.
      complete = length === 0 && at + 12 === b.length && dataRuns === 1;
      break;
    }
    at += 12 + length;
  }
  // A truncated, trailing-byte, dataless or self-contradicting PNG is refused
  // rather than trusted for its header alone.
  if (!complete) return null;
  return { mime: 'image/png', width: u32be(b, 16), height: u32be(b, 20), animated };
}

/**
 * JPEG: every frame header before the scan, MAX-BOUNDED rather than first-match.
 * A file may carry more than one `SOFn`, so reading the first would let a small
 * frame declared ahead of a large one decide the bound.
 */
function readJpeg(b: Uint8Array): RasterHeader | null {
  if (!(b[0] === 0xff && b[1] === 0xd8)) return null;
  // A JPEG's terminal record is EOI. Requiring it is what distinguishes a file
  // that ended from a prefix that merely stopped — not a claim that what lies
  // between the markers decodes.
  if (b.length < 4 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
  let at = 2;
  let width = 0;
  let height = 0;
  let frames = 0;
  let scanned = false;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9) break;
    const length = u16be(b, at + 2);
    // Every segment extent is validated BEFORE anything inside it is read.
    if (length < 2 || length > b.length - at - 2) return null;
    if (marker === 0xda) {
      scanned = true;
      break;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // A frame header is 8 bytes before its component list; anything shorter is
      // not a frame header and must not be read as one.
      if (length < 8) return null;
      frames += 1;
      height = Math.max(height, u16be(b, at + 5));
      width = Math.max(width, u16be(b, at + 7));
    }
    at += 2 + length;
  }
  return frames === 0 || !scanned ? null : { mime: 'image/jpeg', width, height, animated: false };
}

/**
 * GIF: the logical screen, then a real block walk. Every image descriptor is
 * validated against the screen it claims to sit in, so a small screen cannot
 * understate a large frame, and a second descriptor is an animation.
 */
function readGif(b: Uint8Array): RasterHeader | null {
  if (!marks(b, 0, 'GIF87a') && !marks(b, 0, 'GIF89a')) return null;
  if (b.length < 13) return null;
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  const packed = b[10] ?? 0;
  const skipSubBlocks = (from: number): number | null => {
    let cursor = from;
    while (cursor < b.length) {
      const size = b[cursor] ?? 0;
      if (size === 0) return cursor + 1;
      cursor += size + 1;
    }
    return null;
  };
  let at = 13 + ((packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  let frames = 0;
  let complete = false;
  while (at < b.length) {
    const block = b[at];
    if (block === 0x3b) {
      // The trailer is the last byte of the file. Anything after it is a
      // container this parser has not understood, so it is refused.
      complete = at === b.length - 1;
      break;
    }
    if (block === 0x21) {
      const next = skipSubBlocks(at + 2);
      if (next === null) return null;
      at = next;
      continue;
    }
    if (block !== 0x2c) return null;
    frames += 1;
    const left = u16le(b, at + 1);
    const top = u16le(b, at + 3);
    if (left + u16le(b, at + 5) > width || top + u16le(b, at + 7) > height) return null;
    const framePacked = b[at + 9] ?? 0;
    const next = skipSubBlocks(at + 10 + ((framePacked & 0x80) !== 0 ? 3 * 2 ** ((framePacked & 7) + 1) : 0) + 1);
    if (next === null) return null;
    at = next;
  }
  // A GIF without its trailer has been truncated, and a truncated container is
  // refused rather than trusted for the screen descriptor alone.
  return frames === 0 || !complete ? null : { mime: 'image/gif', width, height, animated: frames > 1 };
}

/**
 * WebP: a validated RIFF walk.
 *
 * Animation is decided by the chunks that are actually present, not only by the
 * `VP8X` flag — a file may carry `ANIM`/`ANMF` with the flag clear, and this
 * slice has no pause control for either.
 */
function readWebp(b: Uint8Array): RasterHeader | null {
  if (!marks(b, 0, 'RIFF') || !marks(b, 8, 'WEBP') || b.length < 20) return null;
  // RIFF's size counts every byte after the size field itself. A file that
  // disagrees with its own declaration is truncated or padded, so it is refused.
  if (u32le(b, 4) !== b.length - 8) return null;

  let at = 12;
  let width = 0;
  let height = 0;
  let found = false;
  let animated = false;
  while (at < b.length) {
    // Trailing bytes too short to be a chunk header mean the walk did not land
    // on the end of the file, so the file was not understood.
    if (at + 8 > b.length) return null;
    const size = u32le(b, at + 4);
    const body = at + 8;
    if (size > b.length - body) return null;
    if (marks(b, at, 'ANIM') || marks(b, at, 'ANMF')) animated = true;
    /**
     * MAX-BOUND EVERY dimension record. Gating on the first one lets a small
     * leading `VP8X`/`VP8L`/`VP8 ` hide a larger record later in the same file.
     *
     * RECOGNITION AND SIZE ARE SEPARATE TESTS. Folding the size into the arm
     * (`marks(…) && size >= 10`) makes an undersized record fall through as
     * though it were an unknown chunk, so a valid earlier record could carry a
     * file whose real dimension record is unreadable. Recognised-but-too-short
     * is a container this parser has not understood, and that fails closed.
     */
    if (marks(b, at, 'VP8X')) {
      if (size < 10) return null;
      found = true;
      animated = animated || ((b[body] ?? 0) & 0x02) !== 0;
      width = Math.max(width, u24le(b, body + 4) + 1);
      height = Math.max(height, u24le(b, body + 7) + 1);
    } else if (marks(b, at, 'VP8L')) {
      if (size < 5 || b[body] !== 0x2f) return null;
      found = true;
      const bits =
        ((b[body + 1] ?? 0) | ((b[body + 2] ?? 0) << 8) | ((b[body + 3] ?? 0) << 16) | ((b[body + 4] ?? 0) << 24)) >>>
        0;
      width = Math.max(width, (bits & 0x3fff) + 1);
      height = Math.max(height, ((bits >>> 14) & 0x3fff) + 1);
    } else if (marks(b, at, 'VP8 ')) {
      if (size < 10 || b[body + 3] !== 0x9d || b[body + 4] !== 0x01 || b[body + 5] !== 0x2a) return null;
      found = true;
      width = Math.max(width, u16le(b, body + 6) & 0x3fff);
      height = Math.max(height, u16le(b, body + 8) & 0x3fff);
    }
    // RIFF chunks are padded to an even length.
    at = body + size + (size % 2);
  }
  // Exact exhaustion: the walk must land on the end of the file, not past it.
  return found && at === b.length ? { mime: 'image/webp', width, height, animated } : null;
}

/**
 * The dimensions a payload DECLARES, read before any decoder is handed it, or
 * null when nothing could be read confidently. Null is a refusal, never a pass.
 */
function readRasterHeader(bytes: Uint8Array): RasterHeader | null {
  for (const read of [readPng, readJpeg, readGif, readWebp]) {
    const header = read(bytes);
    if (header === null) continue;
    if (header.width <= 0 || header.height <= 0) return null;
    return header;
  }
  return null;
}

/** Canonical base64 to bytes. The caller has already proved the alphabet. */
function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

function parseImageBlock(alt: string, mime: FyRenderImageMime, payload: string, source: string): FyRenderParseResult {
  const compact = payload.replace(WHITESPACE, '');
  const decoded = decodedBase64Bytes(compact);
  if (decoded === null) return fail('Image payload must be canonical base64');
  if (decoded > FY_RENDER_LIMITS.imageBytes) return fail('Image payload exceeds 2 MiB decoded');

  const refusal = fyRenderRasterRefusal(base64Bytes(compact), mime);
  if (refusal !== null) return fail(refusal);
  return { ok: true, block: { type: 'image', alt, mime, payload: compact, source } };
}

/**
 * The pre-decode admission an inline image passes, for bytes that arrive later.
 *
 * ONE POLICY, TWO ARRIVALS. An inline payload is checked at parse time; an
 * `image` named by `src:` has no bytes until the reader's gesture, so the media
 * renderer runs the very same checks on what the workspace read or the https
 * fetch returned, before any decoder is handed it. A second copy of these rules
 * in the renderer would be a second answer to "what may reach an `<img>`".
 *
 * `expected` is the MIME the caller's extension or declaration names; bytes
 * that disagree are refused, exactly as an inline `mime:` that lies is. Null
 * accepts whichever of the four signatures the bytes carry — the https case,
 * where a URL's suffix is not a declaration anybody made.
 *
 * Returns null when admitted, or the reason.
 */
export function fyRenderRasterRefusal(bytes: Uint8Array, expected: FyRenderImageMime | null): string | null {
  const header = readRasterHeader(bytes);
  if (header === null) return 'Image payload header could not be read';
  // The allowlist has to gate the DECODER, not the label an author typed: bytes
  // that disagree with the declared type would otherwise reach whichever decoder
  // they actually ask for.
  if (expected !== null && header.mime !== expected)
    return `Image bytes are ${header.mime}, not the declared ${expected}`;
  if (header.animated) return `Animated ${header.mime} is not accepted, because this build has no pause control`;
  if (header.width > FY_RENDER_LIMITS.maxDimension || header.height > FY_RENDER_LIMITS.maxDimension)
    return `Image exceeds ${FY_RENDER_LIMITS.maxDimension} pixels on an axis`;
  if (header.width * header.height > FY_RENDER_LIMITS.maxPixels)
    return `Image exceeds ${FY_RENDER_LIMITS.maxPixels} total pixels`;
  return null;
}

/**
 * The MIME a workspace file is shown as, from its extension, or null when this
 * type does not show that kind of file.
 *
 * The extension decides because the daemon's file route serves bytes, not a
 * type, and a `Blob` handed to a media element must say what it is. Null is
 * the `unsupported` fallback card, decided BEFORE any byte is read, so an
 * unsupported file costs the reader no transfer at all. `image` keeps to the
 * four static rasters the inline grammar admits — its bytes still go through
 * `fyRenderRasterRefusal` — and the audio/video lists are the containers every
 * evergreen browser's native player handles, not every container that exists.
 */
const MEDIA_EXTENSIONS: Readonly<Record<FyRenderMediaType, Readonly<Record<string, string>>>> = {
  audio: {
    aac: 'audio/aac',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    oga: 'audio/ogg',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    weba: 'audio/webm',
  },
  image: { gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' },
  pdf: { pdf: 'application/pdf' },
  video: { m4v: 'video/mp4', mov: 'video/quicktime', mp4: 'video/mp4', ogv: 'video/ogg', webm: 'video/webm' },
};

export function fyRenderMediaMime(type: FyRenderMediaType, path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot === -1 || dot < path.lastIndexOf('/')) return null;
  return MEDIA_EXTENSIONS[type][path.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * What a workspace read can answer, as a closed set the renderer presents.
 *
 * This is the WHOLE seam between a transcript block and a daemon, and its shape
 * is the security argument: a path goes in, bytes or a refusal come out. No
 * connection, no URL, no token and no session id crosses it, so the block can
 * show a file without ever holding anything that could open a second one.
 */
export type FyRenderWorkspaceRead =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | {
      readonly ok: false;
      readonly reason: 'missing' | 'denied' | 'not-served' | 'too-large' | 'unavailable';
      /** WHICH rule refused it, in the daemon's words — said to the reader, never folded away. */
      readonly rule?: string;
    };

/** Where the path is read from: the session's working tree, or its media folder (`media:`). */
export type FyRenderWorkspaceScope = 'workspace' | 'media';

export type FyRenderWorkspaceReader = (
  path: string,
  signal: AbortSignal,
  scope?: FyRenderWorkspaceScope,
) => Promise<FyRenderWorkspaceRead>;

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
  const { type, alt, mime, src } = headers;

  const payload = lines.slice(boundary + 1).join('\n');
  // A media block's bytes are elsewhere; a payload beside a `src:` would be
  // bytes nobody consented to and nothing reads. Blank lines are not content.
  if (src !== undefined) {
    if (payload.trim() !== '') return fail('A block with a src header must have an empty payload');
    return { ok: true, block: { type: type as FyRenderMediaType, alt, payload: '', source, src } };
  }
  // `parseHeaders` refuses a video, audio or pdf block without a `src`, and one
  // with a `src` returned above, so only the payload-carrying types remain.
  const kind = type as Exclude<FyRenderType, FyRenderMediaType> | 'image';
  switch (kind) {
    case 'html': {
      if (byteLength(payload) > FY_RENDER_LIMITS.htmlBytes) return fail('HTML payload exceeds 200 KiB');
      return { ok: true, block: { type: kind, alt, payload, source } };
    }
    case 'svg': {
      const reason = validateSvg(payload);
      return reason === null ? { ok: true, block: { type: kind, alt, payload, source } } : fail(reason);
    }
    case 'mermaid': {
      if (characterLength(payload) > FY_RENDER_LIMITS.mermaidCharacters)
        return fail('Mermaid payload exceeds 20,000 characters');
      return { ok: true, block: { type: kind, alt, payload, source } };
    }
    case 'map': {
      if (byteLength(payload) > FY_RENDER_LIMITS.mapBytes) return fail('Map payload exceeds 32 KiB');
      if (payload.trim() === '') return fail('A map block needs a payload describing it');
      return { ok: true, block: { type: kind, alt, payload, source } };
    }
    case 'chart': {
      if (byteLength(payload) > FY_RENDER_LIMITS.chartBytes) return fail('Chart payload exceeds 64 KiB');
      if (payload.trim() === '') return fail('A chart block needs a payload describing it');
      return { ok: true, block: { type: kind, alt, payload, source } };
    }
    case 'lottie': {
      const reason = validateLottie(payload);
      return reason === null ? { ok: true, block: { type: kind, alt, payload, source } } : fail(reason);
    }
    // `mime` is present for every `image` block without a `src`: `parseHeaders`
    // refuses one with neither, and refuses `mime` on any other type.
    case 'image':
      return parseImageBlock(alt, mime as FyRenderImageMime, payload, source);
  }
}

/**
 * The decoded size of a block's payload, in bytes.
 *
 * The consent control names it, so a reader deciding whether to spend a decode
 * knows what they are spending it on. It lives here because the base64 arithmetic
 * is the grammar's, and a second copy in the renderer would be a second answer.
 */
export function fyRenderPayloadBytes(block: FyRenderBlock): number {
  if (block.type !== 'image') return byteLength(block.payload);
  return decodedBase64Bytes(block.payload) ?? 0;
}

/**
 * The two trusted bundles, each with its own closed size cap.
 *
 * THE CAP IS NOT ABOUT TRUST, IT IS ABOUT ALLOCATION. A wrong-hash bundle can
 * never execute — the shell's `script-src` sees to that — but CSP only refuses
 * the bytes AFTER the parent has fetched them, held them in memory and
 * structured-cloned them across a port. A truncated deploy, a captive-portal
 * login page or a mis-routed response would otherwise be read to completion
 * whatever its size. These caps make the read fail before the allocation, which
 * is the only place a size bound does any work.
 *
 * The numbers are the built size plus headroom, not round guesses: Mermaid
 * builds to ~3.4 MiB and Lottie light to ~168 KiB.
 */
export const FY_RENDER_SANDBOX_LIBRARIES = {
  lottie: { maxBytes: 1024 * 1024, url: '/fy-render-lottie.js' },
  mermaid: { maxBytes: 6 * 1024 * 1024, url: '/fy-render-mermaid.js' },
} as const;

export type FyRenderSandboxLibrary = keyof typeof FY_RENDER_SANDBOX_LIBRARIES;

/**
 * Reads a response body to text, refusing at the cap rather than after it.
 *
 * A declared `Content-Length` over the cap is refused without reading a byte;
 * an absent or lying one is caught by the running total, which stops at the
 * first chunk that crosses the line and cancels the stream. Both paths matter:
 * the header is the cheap check and the counter is the honest one.
 */
export type FyRenderBoundedTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

export type FyRenderBoundedBytesResult =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly reason: string };

/**
 * The byte half of the bounded read, shared by the library fetch and the https
 * image fetch. `what` names the response in the refusal, because a reader-facing
 * fold that says "library" about somebody's photograph is wrong twice.
 */
export async function fyRenderReadBoundedBytes(
  response: Response,
  maxBytes: number,
  what = 'library',
): Promise<FyRenderBoundedBytesResult> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return { ok: false, reason: `The ${what} response is too large` };
  }
  const body = response.body;
  if (body === null) return { ok: false, reason: `The ${what} response was empty` };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: `The ${what} response is too large` };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: `The ${what} response could not be read` };
  }

  const joined = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: joined };
}

export async function fyRenderReadBoundedText(
  response: Response,
  maxBytes: number,
): Promise<FyRenderBoundedTextResult> {
  const read = await fyRenderReadBoundedBytes(response, maxBytes);
  return read.ok ? { ok: true, text: new TextDecoder().decode(read.bytes) } : read;
}

/**
 * Everything the frame is allowed to say, as a closed set.
 *
 * A message from an opaque-origin frame is untrusted input even when the code
 * inside it is ours, so this is a parser and not a cast.
 *
 * IT REFUSES; IT DOES NOT REPAIR. An over-long error string is rejected rather
 * than truncated, an unknown `kind` is rejected rather than ignored, and a
 * message carrying ANY key the arm does not name is rejected whole. Clamping
 * looks defensive and is the opposite: it turns a message the sender should
 * never have been able to build into one that passes, which is how a bound
 * stops being evidence of anything. The shell already clips its own strings, so
 * an over-cap arrival means the shell is not the thing that sent it.
 */
export type FyRenderSandboxMessage =
  | { readonly kind: 'shell-ready' }
  | {
      readonly kind: 'mermaid-svg';
      readonly svg: string;
      readonly theme: FyRenderSandboxTheme;
      /** The palette the diagram was painted in (`paletteKey`), echoed so a theme switch can tell it is stale. */
      readonly palette: string;
    }
  | { readonly kind: 'rendered'; readonly width: number; readonly height: number }
  | { readonly kind: 'playing'; readonly playing: boolean }
  | { readonly kind: 'error'; readonly message: string; readonly class: FyRenderSandboxErrorClass }
  /**
   * The `html` shell's two messages. `height` is the page's own scroll height,
   * which the parent clamps — author code can make it say anything within the
   * dimension bound, so it is a layout hint and never a decision. `escape` is a
   * keydown forwarded from inside the frame, because a separate document's keys
   * never reach the app's Escape listener and a reader in fullscreen must be
   * able to leave.
   */
  | { readonly kind: 'height'; readonly height: number }
  | { readonly kind: 'escape' }
  /**
   * The `html` shell's heartbeat, once a second from the bootstrap's own timer. A page that holds the
   * thread stops it, and the parent then stops the page — a guard against a runaway loop, not a CPU
   * quota: author code shares the realm and could keep beating while it does something expensive.
   */
  | { readonly kind: 'beat' };

/** Which way the shell was told to paint, echoed back on the compiled diagram. */
export type FyRenderSandboxTheme = 'dark' | 'light';

/**
 * WHAT WENT WRONG, AS A MACHINE CLASS the shell chooses and the parent never guesses.
 *
 * `library` is the trusted bundle failing to install — the split-deploy case, where
 * the hash-pinned `script-src` refuses bytes that arrived intact. No author byte is
 * involved, so blaming the illustration is simply wrong: the reader must be told the
 * renderer could not be loaded. `render` is everything the DATA can cause — a parse
 * error, a player refusal, a control failure, a re-admission refusal.
 *
 * Why it has to be on the wire rather than inferred: the parent is forbidden from
 * matching on reader-facing strings (a copy edit would silently change behaviour),
 * and the shell is the only side that knows which of the two happened. Before this
 * field existed every `error` became `render`, so a broken deployment told the reader
 * their diagram could not be drawn — the same defect class the deadline copy repair
 * removed, on the most operationally likely path.
 */
export type FyRenderSandboxErrorClass = 'library' | 'render';

const SANDBOX_THEMES: readonly string[] = ['dark', 'light'];
const SANDBOX_ERROR_CLASSES: readonly string[] = ['library', 'render'];

const boundedDimension = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > FY_RENDER_LIMITS.maxDimension) return null;
  return value;
};

/** Exactly these keys, no more and no fewer. */
const hasExactKeys = (message: Record<string, unknown>, keys: readonly string[]): boolean => {
  const present = Object.keys(message);
  return present.length === keys.length && keys.every(key => Object.hasOwn(message, key));
};

export function parseFyRenderSandboxMessage(value: unknown): FyRenderSandboxMessage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  switch (message.kind) {
    case 'shell-ready':
      return hasExactKeys(message, ['kind']) ? { kind: 'shell-ready' } : null;
    case 'mermaid-svg': {
      if (!hasExactKeys(message, ['kind', 'svg', 'theme', 'palette'])) return null;
      const { svg, theme, palette } = message;
      if (typeof svg !== 'string') return null;
      if (byteLength(svg) > FY_RENDER_SANDBOX_LIMITS.mermaidSvgBytes) return null;
      /**
       * THE THEME THE SHELL ACTUALLY COMPILED WITH, refused rather than defaulted.
       *
       * Mermaid cannot see the page, so it is told which way to paint and bakes that
       * into the SVG — which then lives on as an `<img>` for the rest of the
       * transcript. The parent used to re-read the DOM when the diagram arrived,
       * which records the theme in force at CALLBACK time; if the reader switched
       * during the compile, the recorded theme was one the diagram was never drawn
       * with, and the staleness check then agreed with the document forever. Taking
       * the value from the producer closes that. Defaulting an unrecognised value
       * would put the same guess back, so it is refused.
       */
      if (typeof theme !== 'string' || !SANDBOX_THEMES.includes(theme)) return null;
      // The same rule for the palette: the key it was painted under, in the one shape a key has, or nothing.
      if (typeof palette !== 'string' || !PALETTE_KEY.test(palette)) return null;
      return { kind: 'mermaid-svg', palette, svg, theme: theme as FyRenderSandboxTheme };
    }
    case 'rendered': {
      if (!hasExactKeys(message, ['kind', 'width', 'height'])) return null;
      const width = boundedDimension(message.width);
      const height = boundedDimension(message.height);
      if (width === null || height === null) return null;
      return { height, kind: 'rendered', width };
    }
    case 'height': {
      if (!hasExactKeys(message, ['kind', 'height'])) return null;
      const height = boundedDimension(message.height);
      return height === null ? null : { height, kind: 'height' };
    }
    case 'escape':
      return hasExactKeys(message, ['kind']) ? { kind: 'escape' } : null;
    case 'beat':
      return hasExactKeys(message, ['kind']) ? { kind: 'beat' } : null;
    case 'playing': {
      if (!hasExactKeys(message, ['kind', 'playing'])) return null;
      if (typeof message.playing !== 'boolean') return null;
      return { kind: 'playing', playing: message.playing };
    }
    case 'error': {
      if (!hasExactKeys(message, ['kind', 'message', 'class'])) return null;
      const { message: text } = message;
      if (typeof text !== 'string') return null;
      // Refused, not clipped. See the note above.
      if ([...text].length > FY_RENDER_SANDBOX_LIMITS.messageCharacters) return null;
      /**
       * REQUIRED, and refused rather than defaulted to `render`. A default would be
       * the parent guessing again — and it would guess "the illustration is broken"
       * for a message whose sender could not say what happened, which is the exact
       * wrong direction for the split-deploy case this field exists to name.
       */
      const failureClass = message.class;
      if (typeof failureClass !== 'string' || !SANDBOX_ERROR_CLASSES.includes(failureClass)) return null;
      return { class: failureClass as FyRenderSandboxErrorClass, kind: 'error', message: text };
    }
    default:
      return null;
  }
}

/**
 * Re-admits a compiled Mermaid diagram through the same gate an authored SVG
 * passes, before it reaches the `<img>` sink.
 *
 * WHY A GENERATED DOCUMENT IS CHECKED AT ALL. It is the cheap second gate behind
 * the measured `<img>` sink, and for the `<foreignObject>` property it is the
 * FAIL-CLOSED guard behind the shell's config. Mermaid protects only a fixed list
 * of config keys from an in-diagram `%%{init: …}%%` directive, and
 * `flowchart.htmlLabels` is not protectable without blocking every benign
 * flowchart directive, so on paper an author can ask for HTML labels.
 *
 * MEASURED, THEY CANNOT — TODAY. Against the shipped shell config in real
 * Chromium, both spellings of that directive and the plain equivalent diagram
 * compiled to byte-identical SVG carrying no `<foreignObject>`. So the refusal
 * below is untriggered rather than load-bearing, and it stays exactly because the
 * day a Mermaid release changes that, this says so instead of quietly widening
 * what reaches the page.
 *
 * The SIZE caps are looser than the authored ones and deliberately so. A
 * hand-written SVG is bounded because a person wrote it; a compiled one is a
 * machine's expansion of a bounded source, and holding it to 100 KiB would
 * reject diagrams whose Mermaid text was well inside its own cap.
 *
 * THE STRUCTURAL REFUSALS ARE NOT RELAXED, including `<use>`. Measured Mermaid
 * output contains none, so refusing it costs nothing real and keeps this gate
 * fail-closed: the day a Mermaid release starts emitting one, this says so
 * instead of quietly widening what reaches the page. An exemption would need a
 * required generated case and its own no-egress evidence, and neither exists.
 *
 * EVERY AUTHORED RESOURCE CHECK STILL RUNS — bytes, surrogates, DOCTYPE/ENTITY,
 * script, foreignObject, use, root element, unterminated tag, element count,
 * filter primitives and the root canvas bound. Only the three COUNTS get bigger
 * numbers. Dropping a resource check because the producer is trusted would be
 * trusting the producer about the one thing it has no idea about: how much work
 * the reader's browser is about to do. Measured Mermaid output passes the canvas
 * bound as it stands — it declares `width="100%"` against a real `viewBox` and
 * omits `height`, which resolves to the viewBox extent.
 */
export type FyRenderMermaidSvgResult =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly reason: string };

const refuse = (reason: string): FyRenderMermaidSvgResult => ({ ok: false, reason });

export function fyRenderMermaidSvg(svg: string): FyRenderMermaidSvgResult {
  if (byteLength(svg) > FY_RENDER_SANDBOX_LIMITS.mermaidSvgBytes) return refuse('The compiled diagram is too large');
  if (LONE_SURROGATE.test(svg)) return refuse('The compiled diagram contains an unpaired UTF-16 surrogate');
  if (/<!DOCTYPE|<!ENTITY/iu.test(svg)) return refuse('The compiled diagram declares a document type or entity');
  const body = svg.replace(SVG_PROLOGUE, '');
  if (!/^<svg[\s/>]/u.test(body)) return refuse('The compiled diagram is not an <svg> element');
  const scan = scanSvg(svg);
  if (scan === null) return refuse('The compiled diagram has an unterminated tag');
  // BY LOCAL NAME, exactly as the authored path decides it: a compiler that
  // started emitting `<svg:foreignObject>` would otherwise walk straight past a
  // refusal written for the unprefixed spelling.
  if (scan.forbidden !== null) return refuse(`The compiled diagram contains a <${scan.forbidden}> element`);
  if (scan.elements > FY_RENDER_SANDBOX_LIMITS.mermaidSvgElements)
    return refuse(`The compiled diagram exceeds ${FY_RENDER_SANDBOX_LIMITS.mermaidSvgElements} elements`);
  if (scan.filterPrimitives > FY_RENDER_SANDBOX_LIMITS.mermaidSvgFilterPrimitives)
    return refuse(
      `The compiled diagram exceeds ${FY_RENDER_SANDBOX_LIMITS.mermaidSvgFilterPrimitives} filter primitives`,
    );
  if (scan.rootTag === null) return refuse('The compiled diagram root element could not be read');
  const canvas = svgCanvasRefusal(scan.rootTag);
  return canvas === null ? { ok: true, svg } : refuse(canvas);
}
