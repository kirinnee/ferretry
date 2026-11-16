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

export const ChannelPollInputSchema = z.strictObject({
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

export const ChannelAckInputSchema = z.strictObject({ sendIds: z.array(z.string().min(1)).min(1).max(100) });
export type ChannelAckInput = z.infer<typeof ChannelAckInputSchema>;

export const ChannelAckAnswerSchema = z.strictObject({ acked: z.number().int().nonnegative() });
export type ChannelAckAnswer = z.infer<typeof ChannelAckAnswerSchema>;
