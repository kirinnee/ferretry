/**
 * A message that came from another SESSION rather than from the human.
 *
 * The daemon prepends an attribution banner to peer messages because the
 * harness only ever reads message TEXT. In the browser that banner is redundant
 * chrome — the page can render a proper sender chip instead — so it is parsed
 * off here and the remaining prose is what gets shown.
 */
export interface PeerFrom {
  readonly name: string;
  /** The sender is parked awaiting an answer to this message. */
  readonly replyExpected: boolean;
}

/**
 * Matches the banner the daemon emits. Kept TOLERANT on purpose: an
 * unrecognised banner is left in the body rather than half-stripped, so a
 * daemon/page version skew degrades to "shows extra text" and never to
 * "silently eats the first paragraph of a message".
 */
const PEER_BANNER = /^\[peer message from teammate ([^\s(]+)[^\]]*\]\n(.*?)\n\n/s;

export interface PeerMessage {
  /** Null when a human sent this. */
  readonly from: PeerFrom | null;
  readonly body: string;
}

export const peerFrom = (text: string): PeerMessage => {
  const match = PEER_BANNER.exec(text);
  if (!match?.[1]) return { from: null, body: text };
  return {
    from: { name: match[1], replyExpected: /PARKED/.test(match[2] ?? '') },
    body: text.slice(match[0].length),
  };
};
