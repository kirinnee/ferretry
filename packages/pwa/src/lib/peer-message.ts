import type { PeerEnvelope } from '@ferretry/protocol';
import { readUserMessage, unwrapPastedContent } from './user-message.ts';

/**
 * A message that came from another SESSION rather than from the human.
 *
 * The daemon prepends an attribution banner to peer messages because the
 * harness only ever reads message TEXT. In the browser that banner is redundant
 * chrome — the page can render a proper sender chip instead — so it is parsed
 * off here and the remaining prose is what gets shown. The banner's format is
 * the protocol's (`parsePeerEnvelope`), beside the daemon's writer of it.
 */
export type PeerFrom = PeerEnvelope;

export interface PeerMessage {
  /** Null when a human sent this. */
  readonly from: PeerFrom | null;
  /** The message without its banner, and without any paste wrapping the harness added. */
  readonly body: string;
}

/**
 * Splits a message into its sender and body. A paste block the harness wrapped it in is taken off
 * first, which is what lets a Claude transcript's peer message be recognised at all.
 */
export const peerFrom = (text: string): PeerMessage => {
  const message = readUserMessage(text);
  if (message.kind === 'peer') return { from: message.from, body: message.body };
  return { from: null, body: unwrapPastedContent(text) };
};
