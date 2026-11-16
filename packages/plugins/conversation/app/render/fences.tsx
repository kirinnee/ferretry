/**
 * CONVERSATION'S FENCE KIND for Markdown: a fenced `fy-render` block draws as an illustration INSTEAD of the code fence.
 *
 * Markdown (`@ferretry/app`) is a shell facility that holds no feature, so the fence is handed to it as a
 * {@link MarkdownFences}: `remark` marks the fences whose info string is EXACTLY the token (the one place mdast still
 * holds the metadata hast drops), and `draw` replaces the `<pre>` of a marked, parseable fence with its block. A fence
 * that does not parse, an opt-in that is off, or any other language falls through to the ordinary fence, where `code`
 * still highlights or escapes it. There is no partial state: a bad block is indistinguishable from a plain fence.
 *
 * Exactly one production call site opts in (the transcript); every other Markdown reader gets the inert escaped fence by
 * not passing `enableFyRender`.
 */

import type { MarkdownAstFenceNode, MarkdownFences } from '@ferretry/app';
import { FyRenderBlock } from './fy-render-block.tsx';
import { FyRenderCardEmbed, type FyRenderCardEmbedHost } from './fy-render-card-embed.tsx';
import {
  FY_RENDER_FENCE_ATTRIBUTE,
  type FyRenderWorkspaceReader,
  isFyRenderEmbedBlock,
  parseFyRender,
  remarkFyRenderFences,
} from './fy-render.ts';

/**
 * The authored body of a fence `remarkFyRenderFences` marked, or null for every other `<pre>`.
 *
 * TRUSTS THE MARK, NOT THE CLASS NAME. `class="language-fy-render"` is also what a fence opened as `fy-render notes`
 * arrives wearing, because hast keeps the language and drops the metadata. The exact-token decision is made in the
 * remark plugin, where both halves are still visible, and this reads its answer.
 *
 * Read off the `<pre>` rather than the `<code>` because the block replaces the whole fence, and `<figure>` inside `<pre>`
 * is not a tree a browser will keep. When this answers null the `<pre>` renders untouched, which is what makes the
 * failure path free.
 *
 * @internal Exported so the mark has a focused regression of its own.
 */
export function fyRenderFenceBody(node: MarkdownAstFenceNode | null | undefined): string | null {
  const code = node?.children?.[0];
  if (code?.type !== 'element' || code.tagName !== 'code') return null;
  if (code.properties?.[FY_RENDER_FENCE_ATTRIBUTE] !== 'true') return null;
  const body = code.children?.[0];
  if (body?.type !== 'text' || typeof body.value !== 'string') return null;
  // mdast-to-hast terminates a fence body with a newline the author did not type.
  return tolerateAuthoringNoise(body.value.replace(/\n$/u, ''));
}

/**
 * Forgives the three accidents that made a well-meant block draw as code: Windows line endings (the `---` boundary then
 * reads `---\r`), trailing spaces on a header or the boundary line, and blank lines before the first header. Only the
 * header half and the boundary line are touched; everything after the boundary line is the payload and stays
 * byte-for-byte as authored (a CRLF payload keeps its `\r\n`, trailing spaces stay). Still strict where the contract is:
 * the boundary must be exactly `---` once the line's own trailing whitespace is gone, and the language and keys stay
 * lowercase.
 */
export function tolerateAuthoringNoise(source: string): string {
  const lineEnd = /([^\r\n]*)(\r\n|\r|\n|$)/gy;
  let offset = 0;
  while (offset <= source.length) {
    lineEnd.lastIndex = offset;
    const match = lineEnd.exec(source);
    if (match === null) break;
    const [whole, text = '', terminator = ''] = match;
    if (text.trimEnd() === '---') {
      const head = source
        .slice(0, offset)
        .split(/\r\n|\r|\n/u)
        .slice(0, -1)
        .map(line => line.trimEnd());
      while (head.length > 0 && head[0] === '') head.shift();
      const payload = source.slice(offset + whole.length);
      return [...head, '---'].join('\n') + (terminator === '' ? '' : '\n') + payload;
    }
    if (whole === '') break;
    offset += whole.length;
  }
  return source.replace(/\r\n?/gu, '\n');
}

/** What a surface lends the blocks it draws: the file reader for a `src: @path`, and the board to ask for a card. */
export interface FyRenderFenceHost {
  /**
   * Reads a workspace file for a media block's `src: @path`, as the reader. A path goes in and bytes or a refusal come
   * out — never a client, URL or token. Without it a workspace `src:` shows a card saying the view cannot read it.
   */
  readonly readWorkspaceMedia?: FyRenderWorkspaceReader | undefined;
  /** The daemon whose board a `card` or `board` block asks. Without it those blocks stay ordinary code fences. */
  readonly cardEmbed?: FyRenderCardEmbedHost | undefined;
}

/** The fences Conversation's surfaces hand to `<Markdown enableFyRender fences={…}>`. Build once per host; keep it stable. */
export function fyRenderFences(host: FyRenderFenceHost = {}): MarkdownFences {
  return {
    remark: [remarkFyRenderFences],
    draw: ({ node, onTaskOpen }) => {
      const body = fyRenderFenceBody(node);
      const parsed = body === null ? null : parseFyRender(body);
      if (parsed?.ok !== true) return null;
      if (!isFyRenderEmbedBlock(parsed.block))
        return <FyRenderBlock block={parsed.block} readWorkspaceMedia={host.readWorkspaceMedia} />;
      if (host.cardEmbed === undefined) return null;
      return <FyRenderCardEmbed block={parsed.block} host={host.cardEmbed} onTaskOpen={onTaskOpen} />;
    },
  };
}
