import type { BlockDef } from 'durian-hypermedia';
import { tolerateAuthoringNoise } from '../render/authoring-noise.ts';
import { parseFyRender } from '../render/fy-render.ts';
import { type CommonMarkFence, DURIAN_FENCE, linesOf, type SettledFences } from './fence-boundaries.ts';

/**
 * THE PARSER HALF OF `fy-render` AS ONE DURIAN HOST BLOCK (the renderer half is `fy-render-host.tsx`, which says what the
 * block is and why a bad one is plain code). Nothing here imports React or the app shell: this file runs inside the Durian
 * worker (`durian-worker.ts`) as well as in a unit test, so what it reads and what it returns are plain data.
 *
 * WHERE A FENCE ENDS IS NOT DECIDED HERE. `fence-boundaries.ts` decides every fence's boundaries ONCE, by CommonMark
 * (micromark's tokens), before Durian splits the message; a block draws only where its fence was opened as exactly
 * `fy-render` AND has a real closing delimiter, and nothing at or after a fence still open at the tail draws at all.
 */

export const FY_RENDER_BLOCK_NAME = 'fy-render';

/** What the parser hands the component: whether the body is a block, and the body itself, as written. */
export interface FyRenderHostData {
  readonly ok: boolean;
  readonly body: string;
  /** Why it is plain code, when it is (the parser's own words, or the opening line's). */
  readonly reason: string | null;
  /** The description the author wrote, when it is a block: what another agent reads in its place. */
  readonly alt: string | null;
  /** The text Durian makes of this fence for an LLM when the author wrote none, or null: see {@link durianAsIs}. */
  readonly generated: string | null;
}

/**
 * Is this CommonMark fence a block that may be read at all: opened as EXACTLY ` ```fy-render ` (no metadata) AND ended
 * by a real closing delimiter. CommonMark decided both (`fence-boundaries.ts`: indent, containers, tabs, a closer
 * indented four columns, a fence a container or the end of the text cut off); nothing here looks at a line again.
 */
export const isClosedFyRender = (fence: CommonMarkFence | undefined): fence is CommonMarkFence =>
  fence !== undefined && fence.info === FY_RENDER_BLOCK_NAME && fence.meta === '' && fence.close !== null;

/**
 * Reads one `fy-render` fence. Total: never throws, never draws, never reaches a network. `fence` is what CommonMark
 * made of the opening line (absent when it made no fence of it), and its body, with the container markers and the
 * fence's own indent removed, is what is read. `opener` and `durianBody` are Durian's view of the same fence, kept only
 * to tell Durian's own generated LLM text from text the author wrote.
 */
function parseFyRenderBlock(
  fence: CommonMarkFence | undefined,
  opener: string | undefined,
  durianBody: string,
  attrs: Readonly<Record<string, string>> = {},
): FyRenderHostData {
  const generated = durianAsIs(opener, durianBody, attrs);
  const body = fence?.body ?? durianBody;
  if (fence?.info !== FY_RENDER_BLOCK_NAME || fence.meta !== '')
    return { ok: false, body, reason: 'the fence is not opened as exactly fy-render', alt: null, generated };
  if (!isClosedFyRender(fence))
    return { ok: false, body, reason: 'the fence has no closing delimiter', alt: null, generated };
  return readBody(body, generated);
}

/** The body of a fence already decided to be a closed, exactly-`fy-render` one, read by the grammar. */
export function readBody(body: string, generated: string | null): FyRenderHostData {
  const parsed = parseFyRender(tolerateAuthoringNoise(body));
  return parsed.ok
    ? { ok: true, body, reason: null, alt: parsed.block.alt, generated }
    : { ok: false, body, reason: parsed.reason, alt: null, generated };
}

/**
 * What Durian itself puts in a part's `llm` when the author wrote no `:::llm` (the `as-is` rule of `src/core/dh-lib.ts`,
 * `llmFormOf`), or `null` when the opener is not a fence. It is how a part's own generated text is told from text the
 * author wrote: a block's `llm` that differs from it is the author's.
 */
export function durianAsIs(
  opener: string | undefined,
  body: string,
  attrs: Readonly<Record<string, string>>,
): string | null {
  const fence = DURIAN_FENCE.exec(opener ?? '');
  if (fence === null) return null;
  const kept = Object.entries(attrs)
    .filter(([key]) => !['id', 'title', 'kind'].includes(key))
    .map(([key, value]) => `${key}=${/\s/u.test(value) ? `"${value}"` : value}`);
  const open = [`${fence[2]}${fence[3]}`, attrs.kind ?? '', ...kept].filter(Boolean).join(' ');
  return `${open}\n${body.replace(/\n+$/u, '')}\n${fence[2]}`;
}

/**
 * The parser half, for ONE message: reads each fence's boundaries from the table CommonMark made of the text Durian is
 * given (`settleFences`), which agrees with Durian's own split of it. Build it per parse.
 *
 * It has NO `llm` hook on purpose: Durian lets a hook's text replace the part's LLM text, and an author's `:::llm`
 * after the fence is that text. The hook would overwrite it with ours and the reader would never see what the author
 * wrote for an LLM (decision C7: author text is never hidden). Without one the author's text stays on `block.llm`, and
 * `FyRenderPart` draws it.
 */
export function fyRenderParseBlock(settled: SettledFences): BlockDef<FyRenderHostData> {
  const lines = linesOf(settled.text);
  const read = (input: {
    readonly body: string;
    readonly line: number;
    readonly attrs: Readonly<Record<string, string>>;
  }): FyRenderHostData => {
    const open = input.line - 1;
    return parseFyRenderBlock(
      settled.fences.find(fence => fence.open === open),
      lines[open],
      input.body,
      input.attrs,
    );
  };
  return {
    name: FY_RENDER_BLOCK_NAME,
    parse: read,
    check: data =>
      data.ok
        ? []
        : [{ level: 'warn', message: `an fy-render fence is drawn as code: ${data.reason ?? 'it is not a block'}` }],
  };
}

/**
 * What the code slot is told is drawable ({@link drawableBodies}): a key that ignores indentation, and the bodies that
 * share it, each once, in the order their fences were written.
 */
export type DrawableFyRenderBodiesMap = ReadonlyMap<string, readonly string[]>;

/**
 * How the code slot's text is matched to CommonMark's body: EXACTLY, but for the one thing the Markdown renderer spells
 * its own way, the indent of each line (a tab-indented list item) and the newline that ends the text. Every other
 * character, whitespace inside a line included, must be the same, so two blocks that differ only by a space are two keys.
 */
export const bodyKey = (text: string): string =>
  text
    .replace(/\n+$/u, '')
    .split('\n')
    .map(line => line.replace(/^[ \t]+/u, ''))
    .join('\n');

/**
 * The bodies of the fences of one message that may be drawn: opened as exactly `fy-render` and really closed, grouped by
 * {@link bodyKey} and each body once, in fence order. Bodies that differ only by their indent share a key; the slot
 * tells them apart by the text itself.
 */
export const drawableBodies = (settled: SettledFences): DrawableFyRenderBodiesMap => {
  const bodies = new Map<string, string[]>();
  for (const fence of settled.fences.filter(isClosedFyRender)) {
    const key = bodyKey(fence.body);
    const known = bodies.get(key);
    if (known === undefined) bodies.set(key, [fence.body]);
    else if (!known.includes(fence.body)) known.push(fence.body);
  }
  return bodies;
};
