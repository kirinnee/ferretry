/**
 * The cards a machine notice is about (`AgendaItem.cards`): one row per card, the daemon's own line and the card
 * itself. A card is Board's, so Board draws it, through its `ask:card` renderer (the card's reference and title, a link
 * to its page); this half imports nothing of Board's. With no Board on the machine (or outside a shell) the row shows
 * the card's plain reference. Starting a ferret on a card and closing one are Board's writes, made on the card's page.
 */

import { type AgendaCardRow, formatTaskRef } from '../../wire/index.ts';
import { RendererView } from '../../shell.ts';
import type { DaemonConnection } from '../../shell.ts';

export interface AgendaCardsHostProps {
  readonly connection: DaemonConnection;
  readonly cards: readonly AgendaCardRow[];
  readonly onNavigate?: (to: string) => void;
}

/** Board's renderer for a card an ask names. */
export const CARD_ASK_RENDERER = 'ask:card';

export function AgendaCardsHost({ connection, cards }: AgendaCardsHostProps) {
  return (
    <ul className="fy-attn-cards" data-agenda-cards={cards.length}>
      {cards.map(card => (
        <li className="fy-attn-cards__row" data-agenda-card={card.task.id} key={formatTaskRef(card.task)}>
          <span className="fy-attn-cards__card">
            <RendererView
              daemon={connection.daemonId}
              fallback={formatTaskRef(card.task)}
              rendererKey={CARD_ASK_RENDERER}
              value={{ card: card.task.id }}
            />
          </span>
          <span className="fy-attn-cards__line">{card.line}</span>
        </li>
      ))}
    </ul>
  );
}
