/**
 * CONVERSATION'S FENCE DOOR: a fenced `fy-render` block draws as an illustration INSTEAD of the code fence.
 *
 * The hypermedia reader (`../hypermedia/fy-render-host.tsx`) decides which fences are blocks and hands each one's body to
 * `draw`, which answers the block, or `null` where the surface cannot honour it (a `task` with no board to ask) or the
 * body does not parse: that fence stays plain code. There is no partial state: a bad block is indistinguishable from a
 * plain fence. Markdown (`@ferretry/app`) never draws one, so every other reader shows the inert escaped fence.
 */

import type { MarkdownAstFenceNode, ReferenceFences } from '@ferretry/app';
import { tolerateAuthoringNoise } from './authoring-noise.ts';
import { FyRenderBlock } from './fy-render-block.tsx';
import { FyRenderTaskEmbed, type FyRenderTaskEmbedHost } from './fy-render-task-embed.tsx';
import {
  FY_RENDER_FENCE_ATTRIBUTE,
  type FyRenderWorkspaceReader,
  isFyRenderEmbedBlock,
  parseFyRender,
} from './fy-render.ts';

/**
 * The authored body of a fence the hypermedia reader marked, or null for every other node.
 *
 * TRUSTS THE MARK, NOT THE CLASS NAME. `class="language-fy-render"` is also what a fence opened as `fy-render notes`
 * would wear. The exact-token decision is made by the reader (CommonMark's own boundaries), where both halves are still
 * visible, and this reads its answer.
 *
 * When this answers null the fence is drawn as plain code, which is what makes the failure path free.
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

/** What a surface lends the blocks it draws: the file reader for a `src: @path`, and the board to ask for a task. */
export interface FyRenderFenceHost {
  /**
   * Reads a workspace file for a media block's `src: @path`, as the reader. A path goes in and bytes or a refusal come
   * out — never a client, URL or token. Without it a workspace `src:` shows a task saying the view cannot read it.
   */
  readonly readWorkspaceMedia?: FyRenderWorkspaceReader | undefined;
  /** The daemon whose board a `task` or `board` block asks. Without it those blocks stay ordinary code fences. */
  readonly cardEmbed?: FyRenderTaskEmbedHost | undefined;
}

/** The door Conversation's surfaces lend (`ReferenceSurface.fences`). Build once per host; keep it stable. */
export function fyRenderFences(host: FyRenderFenceHost = {}): ReferenceFences {
  return {
    draw: ({ node, onTaskOpen }) => {
      const body = fyRenderFenceBody(node);
      const parsed = body === null ? null : parseFyRender(body);
      if (parsed?.ok !== true) return null;
      if (!isFyRenderEmbedBlock(parsed.block))
        return <FyRenderBlock block={parsed.block} readWorkspaceMedia={host.readWorkspaceMedia} />;
      if (host.cardEmbed === undefined) return null;
      return <FyRenderTaskEmbed block={parsed.block} host={host.cardEmbed} onTaskOpen={onTaskOpen} />;
    },
  };
}
