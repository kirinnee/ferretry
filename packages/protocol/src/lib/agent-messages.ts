/**
 * The text Ferretry itself puts into an agent's conversation: the banner on a message one agent sent
 * another, and the notices the daemon types into a session on its own account.
 *
 * ONE OWNER FOR BOTH ENDS. The daemon writes these into a harness that reads only message TEXT, and
 * the app reads them back out of the transcript to render a peer message as coming FROM that agent —
 * not as "You" — and a notice as a notice. The two sides live in packages that may not import one
 * another, and a banner the daemon rewords while the app still matches the old wording would silently
 * turn every peer message back into a human one. So the format is written once, here, beside the
 * parser that reads it, and each end calls the half it needs.
 *
 * THE PARSERS ARE TOLERANT IN ONE DIRECTION ONLY. An unrecognised shape is left as ordinary text
 * rather than half-stripped, so a daemon/app version skew degrades to "shows extra text" and never to
 * "silently eats the first paragraph of a message".
 */

/** How every peer banner opens; also what marks a user record as a peer message. */
const PEER_OPENING = '[peer message from teammate ';

/** The words in the banner's note that say the sender is blocked on an answer. */
const PEER_PARKED = 'is PARKED waiting for your reply';

/** What the daemon needs to say who sent a message. */
export interface PeerEnvelopeSender {
  /** The sender's agent name, or its session id when it has none. */
  readonly name: string;
  readonly sessionId: string;
  /** The sender is parked until this message is answered. */
  readonly replyExpected: boolean;
  /** The command-line binary the receiver answers with (`fy`). */
  readonly clientName: string;
}

/**
 * The banner prepended to a message one session sent to another, ending in the blank line that
 * separates it from the message.
 *
 * Two lines: the attribution — which session sent it, and that it is not the human lead — and a note
 * saying whether a reply is owed. The reply instruction appears only when the sender is actually
 * parked on one, so a fire-and-forget note never nags its receiver into answering.
 */
export function peerEnvelopePreamble(sender: PeerEnvelopeSender): string {
  const { name, sessionId, replyExpected, clientName } = sender;
  const attribution = `${PEER_OPENING}${name} (session ${sessionId}) — not from the human lead]`;
  const note = replyExpected
    ? `${name} ${PEER_PARKED} and cannot continue until it arrives. Answer with: ${clientName} send ${name} "<your reply>"`
    : `No reply is required; ${name} has carried on. Reply with \`${clientName} send ${name} "…"\` if useful.`;
  return `${attribution}\n${note}\n\n`;
}

/** A peer message as read back out of a transcript. */
export interface PeerEnvelope {
  /** The sender's agent name, exactly as the banner carries it. */
  readonly name: string;
  /** The sender's session id, when the banner names one. */
  readonly sessionId?: string;
  /** The sender was parked on a reply when it sent this. */
  readonly replyExpected: boolean;
  /** The banner's second line — delivery boilerplate addressed to the receiving agent. */
  readonly note: string;
}

const PEER_BANNER = /^\[peer message from teammate ([^\s(\]]+)([^\]]*)\]\n(.*?)\n\n/su;
const PEER_SESSION = /\(session ([^\s)]+)\)/u;

/** Splits a peer message into its envelope and the message itself; `null` when it carries no banner. */
export function parsePeerEnvelope(text: string): { readonly envelope: PeerEnvelope; readonly body: string } | null {
  const match = PEER_BANNER.exec(text);
  if (match === null) return null;
  const [banner, name, rest, note] = match as unknown as [string, string, string, string];
  const sessionId = PEER_SESSION.exec(rest)?.[1];
  return {
    envelope: {
      name,
      ...(sessionId === undefined ? {} : { sessionId }),
      replyExpected: note.includes('PARKED'),
      note,
    },
    body: text.slice(banner.length),
  };
}

/** How every notice the daemon types into a session on its own account opens. */
const NOTICE_TAG = '[ferretry] ';

/** A notice from Ferretry itself, as typed into an agent's session. */
export function ferretryNotice(text: string): string {
  return `${NOTICE_TAG}${text}`;
}

/** The notice's text without its tag; `null` when the message is not a Ferretry notice. */
export function parseFerretryNotice(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(NOTICE_TAG)) return null;
  const notice = trimmed.slice(NOTICE_TAG.length).trim();
  return notice === '' ? null : notice;
}
