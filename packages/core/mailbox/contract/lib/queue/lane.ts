import type { QueueLane, QueuedMessage } from '../../wire-send.ts';

/** What a lane is decided from: the sender and the flags a ferret sent with. All of it is known at accept. */
export type LaneInput = Pick<QueuedMessage, 'sender' | 'label' | 'replyExpected' | 'interrupt'>;

/**
 * A message's LANE, decided ONCE when it is accepted and stored on its `enqueued` line (docs/design/mailbox.md §2.2).
 *
 * A person's words are `owner`; the daemon's notices (Warden, Board, Agenda) are `ferretry`. A ferret's message is
 * `urgent` when it is a blocker, a question (`--ask`, `--expect-reply`) or an interrupt (`--now`), `fyi` when labelled so
 * and an `action` otherwise. Whether it answers what its receiver waits on is NOT known here: that is a promotion at
 * delivery, which keeps this lane. Called again only for a line written before lanes existed.
 */
export function laneOf(input: LaneInput): QueueLane {
  if (input.sender === 'human') return 'owner';
  if (input.sender === 'daemon') return 'ferretry';
  if (input.label === 'blocker' || input.replyExpected === true || input.interrupt === true) return 'urgent';
  return input.label === 'fyi' ? 'fyi' : 'action';
}

/** The order lanes are delivered in: owner, urgent, ferretry, action, fyi. */
export const LANE_ORDER: readonly QueueLane[] = ['owner', 'urgent', 'ferretry', 'action', 'fyi'];

/**
 * The design token each lane is drawn in (the UI is M4; these are the values it reads). `--ok` for Ferretry was
 * approved by the owner.
 */
export const LANE_COLOUR: Readonly<Record<QueueLane, string>> = {
  owner: '--accent',
  urgent: '--err',
  ferretry: '--ok',
  action: '--warn',
  fyi: '--pend',
};
