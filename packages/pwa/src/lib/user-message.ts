/**
 * What a USER record in a transcript actually is, once the harness's own wrapping is taken off.
 *
 * The user channel is the only one a harness reads input from, so three different speakers all arrive
 * as "user" records, and rendering every one of them as a "You" bubble is wrong twice over:
 *
 *   * THE PERSON, typing or pasting. Claude Code records a long or multi-line paste wrapped in
 *     `<pasted_content id="…">…</pasted_content>` markup the person never typed, and it is shown
 *     without it.
 *   * ANOTHER AGENT. A peer send arrives as the daemon's attribution banner and then the message
 *     (`peerEnvelopePreamble` in the protocol). It is shown as a message FROM that agent, not from you.
 *     The daemon always delivers it by bracketed paste — it is multi-line — so on Claude it is ALSO
 *     wrapped in a paste block, which is why the banner used to go unrecognised.
 *   * FERRETRY ITSELF, telling an agent a message it sent did not arrive (`ferretryNotice`). Shown as
 *     a compact system notice.
 *   * THE PERSON, BY WAY OF A FILE. A long, multi-line or attached message is written to a turn document
 *     and the agent is typed one line pointing at it (`turnFileInstruction`), so the record holds that
 *     pointer rather than the person's words. It is read as a hand-off, and the row shows what the file
 *     holds — never the instruction, which reads exactly like something injected.
 *
 * The formats are the protocol's, so the daemon that writes them and this reader cannot drift apart.
 *
 * CODEX HAS NOTHING TO UNWRAP. Its composer collapses a paste to a `[Pasted Content …]` placeholder
 * but submits the full text, so its user record carries the banner bare — the same parse applies.
 *
 * DEGRADE DIRECTION. Anything not recognised is the person's own message, unchanged: the failure mode
 * is a peer message shown as yours with its banner visible (the status quo), never your sentence
 * re-attributed to an agent.
 */

import {
  type HandoffPointer,
  type PeerEnvelope,
  parseFerretryNotice,
  parseHandoffPointer,
  parsePeerEnvelope,
} from '@ferretry/protocol';

/**
 * One paste block. The closing tag is matched with or without attributes — transcripts have been seen
 * repeating the id on it — and the single newline Claude puts inside each tag is not content.
 */
const PASTED_CONTENT = /<pasted_content(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/pasted_content(?:\s[^>]*)?>/gu;

/** The text with every paste block replaced by what was pasted. */
export const unwrapPastedContent = (text: string): string =>
  text.replace(PASTED_CONTENT, (_block, inner: string) => inner);

/** A user record, read. */
export type UserMessage =
  | { readonly kind: 'human'; readonly text: string }
  | { readonly kind: 'peer'; readonly from: PeerEnvelope; readonly body: string }
  | { readonly kind: 'notice'; readonly text: string }
  | { readonly kind: 'handoff'; readonly pointer: HandoffPointer; readonly text: string };

export const readUserMessage = (raw: string): UserMessage => {
  const text = unwrapPastedContent(raw);
  const notice = parseFerretryNotice(text);
  if (notice !== null) return { kind: 'notice', text: notice };
  const pointer = parseHandoffPointer(text);
  if (pointer !== null) return { kind: 'handoff', pointer, text };
  const peer = parsePeerEnvelope(text.trimStart());
  if (peer !== null) return { kind: 'peer', from: peer.envelope, body: peer.body };
  return { kind: 'human', text };
};
