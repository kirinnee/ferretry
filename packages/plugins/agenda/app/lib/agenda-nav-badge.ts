/**
 * THE INBOX DOOR'S COUNT (`shell.navBadges.agenda`, S4): this machine's share of the number on the Agenda nav entry. The
 * shell builds one per paired daemon and draws the SUM, so a machine says only what ITS ferrets wait on the owner for:
 * the open items of every ferret that has one (the same answer `ferrets.needs-you` gives, so a parked item and a notice
 * wait on nobody). Nothing is read until the shell subscribes, and the last unsubscribe stops watching.
 */

import type { FerretsNeedsYou } from '@ferretry/core-ferrets/contract';
import { createNeedsYou } from './needs-you-hook.ts';

/** The shape the shell takes (`NavBadge`): this machine's share, and a way to hear it change. */
export interface InboxBadge {
  readonly count: () => number;
  readonly subscribe: (changed: () => void) => () => void;
}

export const inboxBadgeOf = (needsYou: FerretsNeedsYou): InboxBadge => ({
  count: () => {
    let total = 0;
    for (const ferret of needsYou.needing().values()) total += ferret.count;
    return total;
  },
  subscribe: changed => {
    const stop = needsYou.subscribe(changed);
    const release = needsYou.watch();
    return () => {
      stop();
      release();
    };
  },
});

const SHARED = new WeakMap<object, FerretsNeedsYou>();

/**
 * One machine's needs-you value, made once per client: Ferrets' list (`ferrets.needs-you`) and the nav's Inbox count
 * (`navBadges.agenda`) watch the same value, so the roll-up is read once however many of them watch.
 */
export const needsYouOf = (client: Parameters<typeof createNeedsYou>[0]): FerretsNeedsYou => {
  const known = SHARED.get(client);
  if (known !== undefined) return known;
  const made = createNeedsYou(client);
  SHARED.set(client, made);
  return made;
};
