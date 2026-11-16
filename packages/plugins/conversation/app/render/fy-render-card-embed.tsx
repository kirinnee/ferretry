/**
 * A `card` OR `board` BLOCK: the board's own cards, inline in a message or an agenda body.
 *
 * It is not an illustration, so it has none of an illustration's chrome (no source panel, no fullscreen, no sandbox): the
 * block is a POINTER (`fy-render-embed.ts`) and everything drawn is read from the board by the plugin that owns it.
 * Conversation draws no card itself: each card id is mounted through the `reference:&` renderer the Board declares
 * (`RendererView`), which is the one thing in the app that knows how to prove a card and link it.
 *
 *  - PROOF BEFORE LINK. The Board's renderer answers with a link only for a card it read; a card it could not read, or
 *    one with no Board to ask, stays the written `&F12` as plain text, never a link.
 *  - ONE RENDERER. A host that has no board to read (`cardEmbed` absent) never reaches this file: the fence stays an
 *    ordinary code fence, as any block this build cannot draw does.
 *
 * GAP(board): today's block drew the Board page's own card and lane header (`BoardCard`, `BoardLane`) as a mini board, and
 * the `parent: &F12` form drew the children grouped by lane. Those are Board views; until Board declares a renderer for
 * them the `card` and `board` list forms draw one reference row per card and the `parent:` form says whose cards it
 * names, with the parent's reference as the way in.
 */

import { RendererView } from '@ferretry/app';
import { FileWarning } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FyRenderEmbedBlock } from './fy-render.ts';

/** What a host that can reach a board lends a block: the daemon whose board to ask. */
export interface FyRenderCardEmbedHost {
  readonly daemon: string;
}

export interface FyRenderCardEmbedProps {
  readonly block: FyRenderEmbedBlock;
  readonly host: FyRenderCardEmbedHost;
  /** Opens a card the way a written `&F12` does; absent, the Board's own link is the way in. */
  readonly onTaskOpen?: ((id: string, opener?: HTMLElement | null) => void) | undefined;
}

const noteRow = (id: string, sentence: string): ReactNode => (
  <div className="fy-render-row" data-fy-card-embed-note={id} role="note" key={`note-${id}`}>
    <FileWarning aria-hidden="true" className="fy-render-row-icon" data-tone="warn" size={18} />
    <div className="fy-render-row-body">
      <span className="fy-render-row-name">&{id}</span>
      <span className="fy-render-row-meta">{sentence}</span>
    </div>
  </div>
);

function CardRow({ id, host }: { readonly id: string; readonly host: FyRenderCardEmbedHost }) {
  return (
    <ul className="fy-card-embed-list" data-fy-card-embed-card={id}>
      <li>
        <RendererView daemon={host.daemon} rendererKey="reference:&" value={id} fallback={<span>&{id}</span>} />
      </li>
    </ul>
  );
}

export function FyRenderCardEmbed({ block, host }: FyRenderCardEmbedProps) {
  const { embed } = block;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset draws a border and legend; this is a plain labelled group of cards.
    <div className="fy-card-embed" data-fy-card-embed={block.type} role="group" aria-label={block.alt}>
      {embed.kind === 'card' ? <CardRow id={embed.id} host={host} /> : null}
      {/* The grammar already bounds a list at `embedCards`, so no row is dropped here. */}
      {embed.kind === 'cards' ? embed.ids.map(id => <CardRow key={id} id={id} host={host} />) : null}
      {embed.kind === 'children' ? (
        <>
          {noteRow(embed.parent, 'The cards under this one are on the board.')}
          <CardRow id={embed.parent} host={host} />
        </>
      ) : null}
    </div>
  );
}
