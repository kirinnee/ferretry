import { reviveOf, type SessionView } from '@ferretry/protocol';

/** Whether to put a Resume button in front of this person for this session, and the words for why not. */
export interface ReviveOffer {
  readonly offered: boolean;
  readonly reason: string;
}

/**
 * THE ONE ANSWER every Resume button reads — the chat bar, its Actions menu, a list row's menu, the
 * sidebar and Continue a conversation. It is the daemon's `revive` verdict on the view (or the shared
 * rule, for a daemon that predates it) plus the one thing only this connection knows: whether it may
 * change anything. A surface that decides from `status` itself will one day disagree with the others,
 * which is how the button came to be there on one screen and gone on the next.
 */
export const reviveOffer = (view: SessionView, canControl: boolean): ReviveOffer => {
  if (!canControl) return { offered: false, reason: 'This connection can look but not change anything.' };
  const ruling = reviveOf(view);
  return { offered: ruling.revivable, reason: ruling.reason };
};
