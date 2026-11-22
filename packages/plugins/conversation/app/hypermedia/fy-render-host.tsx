import { type MarkdownAstFenceNode, useReferenceSurface } from '@ferretry/app';
import type { BlockDef, HostBlock } from 'durian-hypermedia';
import type { CodeSlotProps, Slots } from 'durian-hypermedia/react/strict';
import { type ComponentType, createContext, useContext, useMemo } from 'react';
import { FY_RENDER_FENCE_ATTRIBUTE, parseFyRender } from '../render/fy-render.ts';
import { tolerateAuthoringNoise } from '../render/fences.tsx';
import { type CommonMarkFence, DURIAN_FENCE, linesOf, type SettledFences } from './fence-boundaries.ts';
import { LlmOnlyText } from './llm-text.tsx';
import { HYPERMEDIA_SLOTS, HypermediaCode } from './slots.tsx';

/**
 * `fy-render` AS ONE DURIAN HOST BLOCK. The twelve illustration types (`html svg lottie mermaid map chart task board
 * image video audio pdf`) are not Durian parts, and ten of them have no Durian equivalent, so they stay the way an agent
 * authors them: ` ```fy-render `, headers, a `---` boundary line, a payload. This file only re-hosts them. EVERYTHING
 * THAT DRAWS AND EVERYTHING THAT PROVES IS THE EXISTING CODE (`../render/*`, edited by nothing here), so a block
 * reaches the page through the same sinks it always did: `svg` and `image` as an `<img>`, `mermaid` and `lottie` in
 * the sandbox frame, a scripted `html` in its own opaque frame, a `task` or `board` only where the surface lent it a
 * board to ask. An old transcript's fence draws unchanged because it is the same fence.
 *
 * THE RULE THAT KEPT A BAD BLOCK HARMLESS STILL HOLDS: a block that does not parse, a fence whose info string is not
 * EXACTLY `fy-render` (` ```fy-render notes `), and a `task` block on a surface with no board are ORDINARY CODE, drawn
 * the way every other fence in a message is drawn, with no error line and nothing run. Durian would turn a throw into
 * error chrome, so {@link parseFyRenderBlock} never throws; it answers `ok: false` and the component draws the code.
 *
 * WHERE A FENCE ENDS IS NOT DECIDED HERE. `fence-boundaries.ts` decides every fence's boundaries ONCE, by CommonMark
 * (micromark's tokens), before Durian splits the message; a block draws only where its fence was opened as exactly
 * `fy-render` AND has a real closing delimiter, and nothing at or after a fence still open at the tail draws at all.
 *
 * Two halves, because Durian splits them: the parser half (`parse`, `llm`, `check`) needs the message's own text to
 * read the fence's opening line, which Durian's input does not carry, so it is built per message
 * ({@link fyRenderParseBlock}); the renderer half (the component) never changes and is one module-level object
 * ({@link FY_RENDER_COMPONENT_BLOCK}), so a message that re-renders never remounts a frame the reader is using.
 */

const FY_RENDER_BLOCK_NAME = 'fy-render';

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
const isClosedFyRender = (fence: CommonMarkFence | undefined): fence is CommonMarkFence =>
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
function readBody(body: string, generated: string | null): FyRenderHostData {
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
function durianAsIs(opener: string | undefined, body: string, attrs: Readonly<Record<string, string>>): string | null {
  const fence = DURIAN_FENCE.exec(opener ?? '');
  if (fence === null) return null;
  const kept = Object.entries(attrs)
    .filter(([key]) => !['id', 'title', 'kind'].includes(key))
    .map(([key, value]) => `${key}=${/\s/u.test(value) ? `"${value}"` : value}`);
  const open = [`${fence[2]}${fence[3]}`, attrs.kind ?? '', ...kept].filter(Boolean).join(' ');
  return `${open}\n${body.replace(/\n+$/u, '')}\n${fence[2]}`;
}

/**
 * The fence node `remarkFyRenderFences` would have made for this body, which is the one shape the surface's fences read:
 * their `draw` is the host's door (it holds the board and the file reader), and only it may open it.
 */
function synthesizedFence(body: string): MarkdownAstFenceNode {
  return {
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { [FY_RENDER_FENCE_ATTRIBUTE]: 'true' },
        // mdast-to-hast ends a fence body with a newline the author did not type; the reader strips it again.
        children: [{ type: 'text', value: `${body}\n` }],
      },
    ],
  };
}

/**
 * The parser half, for ONE message: reads each fence's boundaries from the table CommonMark made of the text Durian is
 * given (`settleFences`), which agrees with Durian's own split of it. Build it per parse.
 *
 * It has NO `llm` hook on purpose: Durian lets a hook's text replace the part's LLM text, and an author's `:::llm`
 * after the fence is that text. The hook would overwrite it with ours and the reader would never see what the author
 * wrote for an LLM (decision C7: author text is never hidden). Without one the author's text stays on `block.llm`, and
 * {@link FyRenderPart} draws it.
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

/** The code a not-a-block fence is drawn as: this message's own code, so its colours and references match every other fence. */
function PlainFence({ body }: { readonly body: string }) {
  return <HypermediaCode lang={FY_RENDER_BLOCK_NAME} meta="" text={body} />;
}

/** What the author wrote for an LLM after this block, or null when they wrote nothing (Durian's own generated text is not theirs). */
const authorText = (block: HostBlock, data: FyRenderHostData): string | null =>
  block.llm !== null && block.llm !== '' && block.llm !== data.generated ? block.llm : null;

/** A block drawn as its sink, or as the plain code it is. */
function FyRenderBody({ data }: { readonly data: FyRenderHostData }) {
  const { fences, onTaskOpen } = useReferenceSurface();
  const { ok, body } = data;
  // `draw` answers null for a block the surface cannot honour (a `task` with no board to ask), and a surface that
  // never lent fences (a reader outside a ferret) draws nothing: both are the plain fence.
  const drawn = useMemo(
    () => (ok ? (fences?.draw({ node: synthesizedFence(body), onTaskOpen }) ?? null) : null),
    [ok, body, fences, onTaskOpen],
  );
  return drawn ?? <PlainFence body={body} />;
}

/**
 * One fence, drawn or plain, and then the `:::llm` text the author wrote after it, in BOTH cases (decision C7: author
 * text is never hidden): the same collapsed "LLM-only text" disclosure every other part gets.
 */
function FyRenderPart({ block, data }: { readonly block: HostBlock; readonly data: FyRenderHostData }) {
  const text = authorText(block, data);
  return (
    <>
      <FyRenderBody data={data} />
      {text === null ? null : <LlmOnlyText text={text} />}
    </>
  );
}

/** What the code slot is told is drawable ({@link drawableBodies}): a key that ignores whitespace, and the body it stands for. */
const DrawableBodies = createContext<ReadonlyMap<string, string>>(new Map());

/** The provider a message hands its drawable bodies through. */
export const DrawableFyRenderBodies = DrawableBodies.Provider;

/** How the code slot's text is matched to CommonMark's body: the Markdown renderer spells a tab-indented item's indent its own way. */
const bodyKey = (text: string): string => text.replace(/\s+/gu, '');

/** The bodies of the fences of one message that may be drawn: opened as exactly `fy-render` and really closed. */
export const drawableBodies = (settled: SettledFences): ReadonlyMap<string, string> =>
  new Map(settled.fences.filter(isClosedFyRender).map(fence => [bodyKey(fence.body), fence.body]));

/**
 * A ` ```fy-render ` fence Durian did NOT take for a part: one inside a blockquote or a list item is Markdown to Durian
 * and reaches the code slot. The slot is handed only a language, a meta and a text, so it cannot tell where the fence
 * ends: it draws only a fence whose text matches a body CommonMark found in a closed, exactly-`fy-render` fence of THIS
 * message ({@link drawableBodies}), and reads that body, not its own text. Everything else is plain code. (Any other
 * language is the plain code slot's.)
 */
function CodeOrFyRender(props: CodeSlotProps) {
  const drawable = useContext(DrawableBodies);
  const data = useMemo(() => {
    const body =
      props.lang === FY_RENDER_BLOCK_NAME && props.meta === '' ? drawable.get(bodyKey(props.text)) : undefined;
    return body === undefined ? null : readBody(body, null);
  }, [props.lang, props.meta, props.text, drawable]);
  return data === null ? <HypermediaCode {...props} /> : <FyRenderBody data={data} />;
}

/** The slots a message is drawn with: ours, with the code slot that also reads a `fy-render` fence. Module-level, like the slots. */
export const FY_RENDER_SLOTS: Slots = { ...HYPERMEDIA_SLOTS, Code: CodeOrFyRender };

/**
 * The renderer half, module-level and never rebuilt: handed to `DocumentView` as `blocks`, because Durian reads a
 * block's component from there and keys its settings on the array's identity.
 */
export const FY_RENDER_COMPONENT_BLOCK: BlockDef<
  FyRenderHostData,
  ComponentType<{ block: HostBlock; data: FyRenderHostData }>
> = { name: FY_RENDER_BLOCK_NAME, Component: FyRenderPart };

export const FY_RENDER_COMPONENT_BLOCKS: readonly (typeof FY_RENDER_COMPONENT_BLOCK)[] = [FY_RENDER_COMPONENT_BLOCK];
