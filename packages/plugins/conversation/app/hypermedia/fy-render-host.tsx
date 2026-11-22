import { type MarkdownAstFenceNode, useReferenceSurface } from '@ferretry/app';
import type { BlockDef, HostBlock } from 'durian-hypermedia';
import type { CodeSlotProps, Slots } from 'durian-hypermedia/react/strict';
import { type ComponentType, useMemo } from 'react';
import { FY_RENDER_FENCE_ATTRIBUTE, parseFyRender } from '../render/fy-render.ts';
import { tolerateAuthoringNoise } from '../render/fences.tsx';
import { DURIAN_FENCE, durianCloserIndex, isIndentedPastFence, linesOf } from './fence-lines.ts';
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
 * The opening line of a fence that is EXACTLY ` ```fy-render ` (either delimiter, any length from 3), and nothing else,
 * indented by at most three spaces: CommonMark's own limit (four is an indented code block). Durian's fence pattern
 * allows any indent, so the limit is ours to hold.
 */
const EXACT_OPENER = /^ {0,3}(?:`{3,}|~{3,})\s*fy-render\s*$/u;

/**
 * Reads one `fy-render` fence. Total: never throws, never draws, never reaches a network. `opener` is the fence's own
 * opening line (what Durian dropped: its info string), `body` the lines between the delimiters, and `closer` the line
 * Durian ended it at (absent when the caller has none: a fence the code slot already read).
 */
export function parseFyRenderBlock(
  opener: string | undefined,
  body: string,
  attrs: Readonly<Record<string, string>> = {},
  closer?: string,
): FyRenderHostData {
  const generated = durianAsIs(opener, body, attrs);
  if (opener === undefined || !EXACT_OPENER.test(opener))
    return { ok: false, body, reason: 'the fence is not opened as exactly fy-render', alt: null, generated };
  // Durian ends a fence at a closer of any indent; CommonMark does not end it at one indented four columns or more, so a
  // block "closed" that way is not closed, and nothing in it draws.
  if (closer !== undefined && isIndentedPastFence(closer))
    return { ok: false, body, reason: 'the closing fence is indented four spaces or more', alt: null, generated };
  // CommonMark: a fence indented n spaces loses up to n spaces of indentation from each of its lines.
  const indent = /^ */u.exec(opener)?.[0].length ?? 0;
  const dedented =
    indent === 0
      ? body
      : linesOf(body)
          .map(line => stripIndent(line, indent))
          .join('\n');
  const parsed = parseFyRender(tolerateAuthoringNoise(dedented));
  return parsed.ok
    ? { ok: true, body: dedented, reason: null, alt: parsed.block.alt, generated }
    : { ok: false, body: dedented, reason: parsed.reason, alt: null, generated };
}

const stripIndent = (line: string, max: number): string =>
  line.slice(Math.min(max, /^ */u.exec(line)?.[0].length ?? 0));

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
 * The parser half, for ONE message: reads each fence's opening line from `source`. Build it per parse.
 *
 * It has NO `llm` hook on purpose: Durian lets a hook's text replace the part's LLM text, and an author's `:::llm`
 * after the fence is that text. The hook would overwrite it with ours and the reader would never see what the author
 * wrote for an LLM (decision C7: author text is never hidden). Without one the author's text stays on `block.llm`, and
 * {@link FyRenderPart} draws it.
 */
export function fyRenderParseBlock(source: string): BlockDef<FyRenderHostData> {
  const lines = linesOf(source);
  const read = (input: {
    readonly body: string;
    readonly line: number;
    readonly attrs: Readonly<Record<string, string>>;
  }): FyRenderHostData => {
    const open = input.line - 1;
    const fence = DURIAN_FENCE.exec(lines[open] ?? '')?.[2];
    const close = fence === undefined ? -1 : durianCloserIndex(lines, open, fence);
    return parseFyRenderBlock(lines[open], input.body, input.attrs, close < 0 ? undefined : lines[close]);
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

/**
 * A ` ```fy-render ` fence Durian did NOT take for a part: one inside a blockquote or a list item is Markdown to Durian
 * and reaches the code slot. It is the same fence it always was, so it is read and drawn the same way. (Anything that is
 * not exactly `fy-render`, and any other language, is the plain code slot's.)
 */
function CodeOrFyRender(props: CodeSlotProps) {
  const data = useMemo(
    () =>
      props.lang === FY_RENDER_BLOCK_NAME && props.meta === ''
        ? parseFyRenderBlock(`${'`'.repeat(3)}${FY_RENDER_BLOCK_NAME}`, props.text)
        : null,
    [props.lang, props.meta, props.text],
  );
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
