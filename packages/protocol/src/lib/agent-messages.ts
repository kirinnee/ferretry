/**
 * The text Ferretry itself puts into an agent's conversation: the banner on a message one ferret sent
 * another, and the notices the daemon types into a session on its own account.
 *
 * ONE OWNER FOR BOTH ENDS. The daemon writes these into a harness that reads only message TEXT, and
 * the app reads them back out of the transcript to render a peer message as coming FROM that ferret —
 * not as "You" — and a notice as a notice. The two sides live in packages that may not import one
 * another, and a banner the daemon rewords while the app still matches the old wording would silently
 * turn every peer message back into one the owner typed. So the format is written once, here, beside
 * the parser that reads it, and each end calls the half it needs.
 *
 * THE PARSERS ARE TOLERANT IN ONE DIRECTION ONLY. An unrecognised shape is left as ordinary text
 * rather than half-stripped, so a daemon/app version skew degrades to "shows extra text" and never to
 * "silently eats the first paragraph of a message". The banner an older daemon wrote is still read, so
 * a transcript recorded before the rewording keeps rendering as the ferret that sent it.
 *
 * The contract — the wording, the kinds, and what each Chat shows — is docs/ferret-messages.md.
 */

/**
 * What one ferret's message to another IS:
 *
 *   * `message` — a note; the sender has carried on and did not say whether it wants an answer.
 *   * `question` — the sender asked for an answer: parked until it comes (`send --ask`), or carrying on
 *     while it waits for one (`send --expect-reply`).
 *   * `reply` — the answer to a question the RECEIVER asked, and is parked on.
 */
export const PEER_MESSAGE_KINDS = ['message', 'question', 'reply'] as const;
export type PeerMessageKind = (typeof PEER_MESSAGE_KINDS)[number];

/** What the daemon needs to say who sent a message. */
export interface PeerEnvelopeSender {
  /** The sender's ferret name, or its session id when it has none. */
  readonly name: string;
  readonly sessionId: string;
  readonly kind: PeerMessageKind;
  /** The command-line binary the receiver answers with (`fy`). */
  readonly clientName: string;
}

/**
 * The banner prepended to a message one ferret sent another, ending in the blank line that separates
 * it from the message.
 *
 * Two short lines, because the receiver reads them in every peer message it is ever sent: who it is
 * from and that it is not the owner, then whether an answer is owed and the one command that sends it.
 * Only a `question` asks for an answer, so a note never nags its receiver into replying — and a note
 * never says no answer is owed either: a sender that forgot `--expect-reply` may still be waiting on
 * one, and "No reply needed" over "send your verdict now" left a lead's sub-ferrets silent for hours
 * (2026-10-31).
 */
export function peerEnvelopePreamble(sender: PeerEnvelopeSender): string {
  const { name, sessionId, kind, clientName } = sender;
  const attribution = `[${kind} from ferret ${name} (session ${sessionId}) — not from the owner]`;
  const command = `${clientName} send ${name} "<reply>"`;
  const note =
    kind === 'question' ? `${name} is waiting for your answer. Reply with: ${command}` : `To reply: ${command}`;
  return `${attribution}\n${note}\n\n`;
}

/** A peer message as read back out of a transcript. */
export interface PeerEnvelope {
  /** The sender's ferret name, exactly as the banner carries it. */
  readonly name: string;
  /** The sender's session id, when the banner names one. */
  readonly sessionId?: string;
  readonly kind: PeerMessageKind;
  /** The sender asked for an answer when it sent this — the same fact as `kind === 'question'`. */
  readonly replyExpected: boolean;
  /** The banner's second line — delivery boilerplate addressed to the receiving agent. */
  readonly note: string;
}

const PEER_BANNER = /^\[(message|question|reply) from ferret ([^\s(\]]+)([^\]]*)\]\n(.*?)\n\n/su;
/** The wording a daemon wrote before peers were called ferrets; read, never written. */
const OLDER_PEER_BANNER = /^\[peer message from teammate ([^\s(\]]+)([^\]]*)\]\n(.*?)\n\n/su;
const PEER_SESSION = /\(session ([^\s)]+)\)/u;

const envelopeOf = (name: string, rest: string, kind: PeerMessageKind, note: string): PeerEnvelope => {
  const sessionId = PEER_SESSION.exec(rest)?.[1];
  return {
    name,
    ...(sessionId === undefined ? {} : { sessionId }),
    kind,
    replyExpected: kind === 'question',
    note,
  };
};

/** Splits a peer message into its envelope and the message itself; `null` when it carries no banner. */
export function parsePeerEnvelope(text: string): { readonly envelope: PeerEnvelope; readonly body: string } | null {
  const current = PEER_BANNER.exec(text);
  if (current !== null) {
    const [banner, kind, name, rest, note] = current as unknown as [string, PeerMessageKind, string, string, string];
    return { envelope: envelopeOf(name, rest, kind, note), body: text.slice(banner.length) };
  }
  const older = OLDER_PEER_BANNER.exec(text);
  if (older === null) return null;
  const [banner, name, rest, note] = older as unknown as [string, string, string, string];
  // The older wording said a parked sender was "PARKED"; it had no word for a reply.
  const kind: PeerMessageKind = note.includes('PARKED') ? 'question' : 'message';
  return { envelope: envelopeOf(name, rest, kind, note), body: text.slice(banner.length) };
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

/**
 * A notice as the app draws it: its first paragraph is the headline a person reads, and anything
 * after the first blank line is addressed to the agent — shown only behind a "details" control.
 */
export function splitFerretryNotice(notice: string): { readonly headline: string; readonly details: string | null } {
  const [headline = '', ...rest] = notice.split(/\n[^\S\n]*\n/u);
  const details = rest.join('\n\n').trim();
  return { headline: headline.trim(), details: details === '' ? null : details };
}
