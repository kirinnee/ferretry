/**
 * A BOARD ALERT IS NEVER TYPED INTO THE OWNER'S OWN CHAT. A stale card, a red CI and a PR closed unmerged are
 * routed by `noticeRecipient` (`notice-route.ts`), which falls to an interactive session only when no automatic one is alive —
 * and for a lead the owner chats with, whose sub-ferrets have ended, that is nearly always: from 2026-10-31 to
 * 2026-11-03 one such lead had 177 of them typed into it as turns, 158 of them "CI is red".
 *
 * The send path cannot hold them back: a daemon message to an interactive session is not in the queue's delivery
 * order (`boardOnly`), so the queue hands it to the direct send path, which TYPES it. So this does, at the one
 * place every alert passes, whoever it was routed to — the alert route, the pre-routing fallback, or a sub-ferret's
 * lead standing in for it. The session's mode is read as the send path reads it (`config.mode`).
 *
 * Holding one back loses nothing the board does not show: a red CI is the card's PR fact, a PR closed unmerged is
 * a note in the card's history, a stale card is its activity. The alert is journalled on the session it was for,
 * so what was withheld can be counted. An automatic session gets every alert as before.
 *
 * A PRIVATE card is hidden from the default board, so a red CI or a PR closed unmerged on one is seen by nobody
 * who does not open it. Such an alert is also written as a note on the nearest PUBLIC ancestor ({@link AlertSurface}),
 * which the owner's board does show — still not a turn. A stale nudge is journalled only: it is a card's own
 * quiet, and a note on its parent would count as the parent's activity.
 */
import type { BoardTask, BoardTaskId, InteractionMode } from '@ferretry/protocol';
import { boardOnly } from '../session/queue/policy.ts';
import { BoardIndex } from './graph.ts';
import { cardVisibility } from './visibility.ts';

export interface BoardAlertPorts {
  /** How the session takes messages, as the send path reads it; `undefined` when it cannot be read. */
  mode(sessionId: string): Promise<InteractionMode | undefined>;
  /** Sends the alert to the session through the ordinary send path, as the board's. */
  send(sessionId: string, message: string): Promise<void>;
  /** Journals an alert that was held back on the session it was for. */
  withheld(sessionId: string, message: string): Promise<void>;
  /** Puts a held-back alert about a card where the board shows it, without typing it anywhere. */
  surface(card: BoardTaskId, message: string): Promise<void>;
}

/** What became of one alert: typed by the send path, or held back from an interactive session. */
export type BoardAlertOutcome = 'sent' | 'withheld';

export class BoardAlerts {
  constructor(private readonly ports: BoardAlertPorts) {}

  /**
   * Sends one alert unless its session is interactive. A session whose mode cannot be read — or whose read fails —
   * is sent to: the send path refuses one it cannot read, exactly as before. `about` names the card whose
   * actionable alert this is, so a held-back one can be surfaced on the board.
   */
  async send(sessionId: string, message: string, about?: BoardTaskId): Promise<BoardAlertOutcome> {
    const mode = await this.ports.mode(sessionId).catch(() => undefined);
    if (mode !== undefined && boardOnly({ sender: 'daemon' }, mode)) {
      await this.ports.withheld(sessionId, message);
      if (about !== undefined) await this.ports.surface(about, message);
      return 'withheld';
    }
    await this.ports.send(sessionId, message);
    return 'sent';
  }
}

export interface AlertSurfacePorts {
  /** Every readable card. */
  cards(): Promise<readonly BoardTask[]>;
  /** Writes a note on a card's history as the daemon. */
  note(card: BoardTaskId, text: string): Promise<void>;
  machineId(): string | undefined;
}

/** The nearest ancestor of `card` that is public, never the card itself; `undefined` when there is none. */
const publicAncestor = (card: BoardTask, index: BoardIndex): BoardTask | undefined => {
  const seen = new Set<BoardTaskId>([card.id]);
  let parent = card.parent === null ? undefined : index.get(card.parent);
  while (parent !== undefined && !seen.has(parent.id)) {
    if (cardVisibility(parent) === 'public') return parent;
    seen.add(parent.id);
    parent = parent.parent === null ? undefined : index.get(parent.parent);
  }
  return undefined;
};

/**
 * Where a held-back alert about a PRIVATE card is seen: a note on its nearest public ancestor, which the default
 * board lists. A public card needs nothing (its own PR facts show), and a private card with no public ancestor has
 * nowhere visible to go — a declared gap (docs/board.md).
 */
export class AlertSurface {
  constructor(private readonly ports: AlertSurfacePorts) {}

  async surface(id: BoardTaskId, message: string): Promise<void> {
    const cards = await this.ports.cards();
    const card = cards.find(entry => entry.id === id);
    if (card === undefined || cardVisibility(card) === 'public') return;
    const ancestor = publicAncestor(card, new BoardIndex(cards, this.ports.machineId() ?? ''));
    if (ancestor !== undefined)
      await this.ports.note(ancestor.id, `sub-card alert, not typed to the interactive lead: ${message}`);
  }
}
