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
 */
import type { InteractionMode } from '@ferretry/protocol';
import { boardOnly } from '../session/queue/policy.ts';

export interface BoardAlertPorts {
  /** How the session takes messages, as the send path reads it; `undefined` when it cannot be read. */
  mode(sessionId: string): Promise<InteractionMode | undefined>;
  /** Sends the alert to the session through the ordinary send path, as the board's. */
  send(sessionId: string, message: string): Promise<void>;
  /** Journals an alert that was held back on the session it was for. */
  withheld(sessionId: string, message: string): Promise<void>;
}

/** What became of one alert: typed by the send path, or held back from an interactive session. */
export type BoardAlertOutcome = 'sent' | 'withheld';

export class BoardAlerts {
  constructor(private readonly ports: BoardAlertPorts) {}

  /**
   * Sends one alert unless its session is interactive. A session whose mode cannot be read is sent to: the send
   * path refuses one it cannot read, exactly as before.
   */
  async send(sessionId: string, message: string): Promise<BoardAlertOutcome> {
    const mode = await this.ports.mode(sessionId);
    if (mode !== undefined && boardOnly({ sender: 'daemon' }, mode)) {
      await this.ports.withheld(sessionId, message);
      return 'withheld';
    }
    await this.ports.send(sessionId, message);
    return 'sent';
  }
}
