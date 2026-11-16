import type { TranscriptEvent, TranscriptMessageEvent } from './types.ts';

/**
 * Whether a transcript event is a message the OWNER sent: a user-channel message the harness did not
 * write itself.
 *
 * The user channel is the only one a harness reads back, so Claude Code writes its own events there
 * too — a background command finishing, a subagent's message, a meta record — and each lands as a
 * `user` record a person never typed. Every reader of "what the owner said" (a conversation's title, its
 * recent exchanges, the last owner message) asks this rather than `role === 'user'`, so such an event
 * can never become the owner's words.
 */
export const isOwnerMessage = (event: TranscriptEvent): event is TranscriptMessageEvent =>
  event.kind === 'message' && event.role === 'user' && event.inputSource !== 'harness';
