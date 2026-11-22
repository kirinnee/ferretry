import { type MarkdownAstFenceNode, useReferenceSurface } from '@ferretry/app';
import type { BlockDef, HostBlock } from 'durian-hypermedia';
import type { CodeSlotProps, Slots } from 'durian-hypermedia/react/strict';
import { type ComponentType, createContext, useContext, useMemo } from 'react';
import { FY_RENDER_FENCE_ATTRIBUTE } from '../render/fy-render.ts';
import {
  bodyKey,
  type DrawableFyRenderBodiesMap,
  FY_RENDER_BLOCK_NAME,
  type FyRenderHostData,
  readBody,
} from './fy-render-parse.ts';
import { authorTextBeside, LlmOnlyText } from './llm-text.tsx';
import { HYPERMEDIA_SLOTS, HypermediaCode } from './slots.tsx';

/**
 * `fy-render` AS ONE DURIAN HOST BLOCK, the renderer half. The twelve illustration types (`html svg lottie mermaid map chart task board
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
 * error chrome, so the parser half (`fy-render-parse.ts`, which runs in the Durian worker) never throws; it answers
 * `ok: false` and the component draws the code.
 *
 * Two halves, because Durian splits them, and a third reason now: the parser half runs off the main thread, so it lives in a
 * file with no React in it. The renderer half (the component) never changes and is one module-level object
 * ({@link FY_RENDER_COMPONENT_BLOCK}), so a message that re-renders never remounts a frame the reader is using.
 */

/**
 * The fence node the door (`render/fences.tsx`) reads for this body, which is the one shape the surface's fences read:
 * their `draw` is the host's door (it holds the board and the file reader), and only it may open it.
 */
export function synthesizedFence(body: string): MarkdownAstFenceNode {
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

/** The code a not-a-block fence is drawn as: this message's own code, so its colours and references match every other fence. */
function PlainFence({ body }: { readonly body: string }) {
  return <HypermediaCode lang={FY_RENDER_BLOCK_NAME} meta="" text={body} />;
}

/** What the author wrote for an LLM after this block, or null when they wrote nothing (Durian's own generated text is not theirs). */
const authorText = (block: HostBlock, data: FyRenderHostData): string | null => authorTextBeside(block, data.generated);

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

const DrawableBodies = createContext<DrawableFyRenderBodiesMap>(new Map());

/** The provider a message hands its drawable bodies through. */
export const DrawableFyRenderBodies = DrawableBodies.Provider;

/** A text without the newlines that end it: how the renderer ends a fence's text, which the author did not type. */
const withoutTrailingNewlines = (text: string): string => text.replace(/\n+$/u, '');

/** The whitespace a line begins with. */
const indentOf = (line: string): string => /^[ \t]*/u.exec(line)?.[0] ?? '';

/**
 * Could the Markdown renderer have spelled `candidate` as `text`? Line for line the same, but for the indent of a line that
 * begins with a TAB in the candidate: the renderer keeps a tab in one place (a quote) and expands it to spaces in another
 * (a quoted list), where it cannot be told from the spaces an author typed. Every other line must be spelled exactly.
 */
function couldBeSpelled(candidate: string, text: string): boolean {
  const written = withoutTrailingNewlines(candidate).split('\n');
  const seen = withoutTrailingNewlines(text).split('\n');
  return (
    written.length === seen.length &&
    written.every((line, index) => {
      const other = seen[index] ?? '';
      if (line === other) return true;
      const lead = indentOf(line);
      return lead.includes('\t') && !indentOf(other).includes('\t') && line.slice(lead.length) === other.trimStart();
    })
  );
}

/**
 * The body a code slot's text stands for, or `undefined` when it is not provably one of this message's. Bodies that differ
 * only by indentation are told apart by the text itself: the slot's text is the one of them it could be the spelling of
 * ({@link couldBeSpelled}: the Markdown renderer keeps a fence's own indentation; it only re-spells a tab-indented line).
 * A text that could be the spelling of none of several, or of more than one (a tab-indented body and its space-indented
 * twin: the renderer's expansion of the first IS the second), is AMBIGUOUS and stays plain code, so no block's content is
 * ever replaced by another's and no body is drawn under the wrong fence or twice.
 */
const bodyFor = (drawable: DrawableFyRenderBodiesMap, text: string): string | undefined => {
  const candidates = drawable.get(bodyKey(text));
  if (candidates === undefined) return undefined;
  if (candidates.length === 1) return candidates[0];
  const spelled = candidates.filter(candidate => couldBeSpelled(candidate, text));
  return spelled.length === 1 ? spelled[0] : undefined;
};

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
    const body = props.lang === FY_RENDER_BLOCK_NAME && props.meta === '' ? bodyFor(drawable, props.text) : undefined;
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
