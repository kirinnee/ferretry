/**
 * The Claude channel: how an agent's or the daemon's message reaches a running Claude Code session through the MCP
 * server Ferretry already launches for it (`fy mcp serve`), instead of being typed into its composer.
 *
 * The MCP server polls these two agent tools AS the session (the credential the daemon put in its environment names
 * the ferret, so nothing a model says can name another one) and forwards each message as a
 * `notifications/claude/channel`. They are not in the tools list a model reads: only the server's own pump calls them.
 */
import { z } from 'zod';

/** The longest one `channel_poll` is held open: under every transport's timeout, like the other waiting tools. */
export const CHANNEL_POLL_MAX_WAIT_MS = 25_000;

/** Names one subscriber: a fresh id per `fy mcp serve` process, so a restarted server fences out the old one's claims. */
export const ChannelGenerationSchema = z.string().min(1).max(128);

export const ChannelPollInputSchema = z.strictObject({
  generation: ChannelGenerationSchema,
  waitMs: z.number().int().min(0).max(CHANNEL_POLL_MAX_WAIT_MS).optional(),
});
export type ChannelPollInput = z.infer<typeof ChannelPollInputSchema>;

/** One message waiting to be forwarded: its send id, and the exact text that would have been typed (banner line included). */
export const ChannelMessageSchema = z.strictObject({
  sendId: z.string().min(1),
  text: z.string().min(1),
  /** Who sent it, as a tag attribute reads it: the sending ferret's name, or `Ferretry` for the daemon. Absent for neither. */
  from: z.string().min(1).optional(),
});
export type ChannelMessage = z.infer<typeof ChannelMessageSchema>;

export const ChannelPollAnswerSchema = z.strictObject({ messages: z.array(ChannelMessageSchema) });
export type ChannelPollAnswer = z.infer<typeof ChannelPollAnswerSchema>;

/**
 * The second phase of a hand-out: the server is about to write this message to Claude and asks the daemon to mark it
 * pushed. Granted only while it is still ours to push — not withdrawn, and the generation still the current subscriber.
 */
export const ChannelClaimInputSchema = z.strictObject({
  generation: ChannelGenerationSchema,
  sendId: z.string().min(1),
});
export type ChannelClaimInput = z.infer<typeof ChannelClaimInputSchema>;

/**
 * How long after it SENT a claim request the server may still write the notification. The one owner of the number: the
 * daemon hands it back in every claim answer (so the two ends can never disagree on it), the server writes only when the
 * granted answer reached it within this long of its own send (its own monotonic clock, no clock shared with the daemon),
 * and the daemon never gives up on a claimed message — never types it — before the grant plus this plus the receipt window.
 * The server's send time is never later than the daemon's grant time, so its deadline is always over before the daemon's.
 */
export const CHANNEL_WRITE_BUDGET_MS = 2_000;

export const ChannelClaimAnswerSchema = z.strictObject({
  claimed: z.boolean(),
  /** {@link CHANNEL_WRITE_BUDGET_MS}: how long after sending the request a granted claim may still be written. */
  writeBudgetMs: z.number().int().positive(),
});
export type ChannelClaimAnswer = z.infer<typeof ChannelClaimAnswerSchema>;
