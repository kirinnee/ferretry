/**
 * FAKE DATA ONLY: a Codex ferret's transcript as `codex queue` leaves it. Codex records a queued message as an ORDINARY
 * user turn in the rollout (`response_item` / `message` / `user`), so the parser emits the same `user/message` event a
 * typed message makes. An agent's send carries the daemon's banner line (the text a typed send would have been typed
 * under, byte for byte); an owner's carries none.
 *
 * `CODEX_QUEUED_EVENTS` is what the Codex parser yields for those rollout lines (the Codex plugin's own test proves
 * that half); `CODEX_QUEUED_LOG` is what the reader's `renderTranscript` makes of them (the Conversation test proves
 * that half), and the chat reads that text. Kept as plain data so a browser scene can import it.
 */
const TORREY_BANNER =
  '[message · action from ferret torrey (session mvtorre1-a41c8b02) — not from the owner] To reply: fy send torrey "<reply>"\n';

export const TORREY_BODY = 'Review is done — three findings, the patch is on the branch.';
export const OWNER_BODY = 'Thanks. Please land the patch once CI is green.';

const metadata = (second: number) => ({
  harness: 'codex' as const,
  source: 'rollout.jsonl',
  timestamp: `2026-11-16T10:00:${String(second).padStart(2, '0')}.000Z`,
});

export const CODEX_QUEUED_EVENTS = [
  { ...metadata(0), role: 'user' as const, kind: 'message' as const, text: `${TORREY_BANNER}${TORREY_BODY}` },
  { ...metadata(5), role: 'assistant' as const, kind: 'message' as const, text: 'Reading the findings now.' },
  { ...metadata(30), role: 'user' as const, kind: 'message' as const, text: OWNER_BODY },
  { ...metadata(35), role: 'assistant' as const, kind: 'message' as const, text: 'Landing it as soon as CI is green.' },
];

export const CODEX_QUEUED_LOG = [
  `[10:00:00] user/message: ${TORREY_BANNER.trimEnd()}`,
  `    ${TORREY_BODY}`,
  '[10:00:05] assistant/message: Reading the findings now.',
  `[10:00:30] user/message: ${OWNER_BODY}`,
  '[10:00:35] assistant/message: Landing it as soon as CI is green.',
].join('\n');
