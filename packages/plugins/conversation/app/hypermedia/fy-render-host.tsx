import { type MarkdownAstFenceNode, useReferenceSurface } from '@ferretry/app';
import type { BlockDef, HostBlock } from 'durian-hypermedia';
import { type ComponentType, useMemo } from 'react';
import { FY_RENDER_FENCE_ATTRIBUTE, parseFyRender } from '../render/fy-render.ts';
import { tolerateAuthoringNoise } from '../render/fences.tsx';
import { HYPERMEDIA_SLOTS } from './slots.tsx';

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
}

/** The opening line of a fence that is EXACTLY ` ```fy-render ` (either delimiter, any length from 3), and nothing else. */
const EXACT_OPENER = /^\s*(?:`{3,}|~{3,})\s*fy-render\s*$/u;

const linesOf = (source: string): readonly string[] => source.split(/\r\n|\r|\n/u);

/**
 * Reads one `fy-render` fence. Total: never throws, never draws, never reaches a network. `opener` is the fence's own
 * opening line (what Durian dropped: its info string), `body` the lines between the delimiters.
 */
export function parseFyRenderBlock(opener: string | undefined, body: string): FyRenderHostData {
  if (opener === undefined || !EXACT_OPENER.test(opener))
    return { ok: false, body, reason: 'the fence is not opened as exactly fy-render', alt: null };
  const parsed = parseFyRender(tolerateAuthoringNoise(body));
  return parsed.ok
    ? { ok: true, body, reason: null, alt: parsed.block.alt }
    : { ok: false, body, reason: parsed.reason, alt: null };
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

const FENCE = '`'.repeat(3);

/** The parser half, for ONE message: reads each fence's opening line from `source`. Build it per parse. */
export function fyRenderParseBlock(source: string): BlockDef<FyRenderHostData> {
  const lines = linesOf(source);
  const read = (input: { readonly body: string; readonly line: number }): FyRenderHostData =>
    parseFyRenderBlock(lines[input.line - 1], input.body);
  return {
    name: FY_RENDER_BLOCK_NAME,
    parse: read,
    // What another agent reads in place of the picture: the description the author had to write. A block that is not a
    // block is the fence as written.
    llm: (data, input) => data.alt ?? `${FENCE}${FY_RENDER_BLOCK_NAME}\n${input.body}\n${FENCE}`,
    check: data =>
      data.ok
        ? []
        : [{ level: 'warn', message: `an fy-render fence is drawn as code: ${data.reason ?? 'it is not a block'}` }],
  };
}

/** The code a not-a-block fence is drawn as: this message's own code slot, so its colours and references match every other fence. */
function PlainFence({ body }: { readonly body: string }) {
  const Code = HYPERMEDIA_SLOTS.Code;
  if (Code === undefined)
    return (
      <pre>
        <code>{body}</code>
      </pre>
    );
  return <Code lang={FY_RENDER_BLOCK_NAME} meta="" text={body} />;
}

function FyRenderPart({ data }: { readonly block: HostBlock; readonly data: FyRenderHostData }) {
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
 * The renderer half, module-level and never rebuilt: handed to `DocumentView` as `blocks`, because Durian reads a
 * block's component from there and keys its settings on the array's identity.
 */
export const FY_RENDER_COMPONENT_BLOCK: BlockDef<
  FyRenderHostData,
  ComponentType<{ block: HostBlock; data: FyRenderHostData }>
> = { name: FY_RENDER_BLOCK_NAME, Component: FyRenderPart };

export const FY_RENDER_COMPONENT_BLOCKS: readonly (typeof FY_RENDER_COMPONENT_BLOCK)[] = [FY_RENDER_COMPONENT_BLOCK];
