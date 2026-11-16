import { ferretOf } from '@ferretry/core-gate/contract';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import {
  ChannelClaimInputSchema,
  ChannelPollInputSchema,
  CHANNEL_POLL_MAX_WAIT_MS,
  CHANNEL_WRITE_BUDGET_MS,
} from '../../contract/wire-channel.ts';
import type { ChannelOutbox } from './lib/outbox.ts';

const NOT_A_FERRET =
  'The channel belongs to a ferret: run this from inside a ferret, with the credential Ferretry gives each one.';

/**
 * The two agent tools the Claude MCP server pumps its channel with, as the session that called them. The caller is the
 * ferret the credential names; nothing in the arguments can name another one.
 *
 * `channel_poll` OFFERS candidates; `channel_claim` is asked once per candidate right before the server writes it, and is
 * granted only while the message is still ours to push (see the outbox). Neither says Claude received anything.
 */
export function channelTools(outbox: ChannelOutbox): {
  readonly channel_poll: ToolHandler;
  readonly channel_claim: ToolHandler;
} {
  return {
    channel_poll: async (call, input) => {
      const ferret = ferretOf(call);
      if (ferret === undefined) return { text: NOT_A_FERRET, isError: true };
      const parsed = ChannelPollInputSchema.safeParse(input ?? {});
      if (!parsed.success)
        return { text: 'channel_poll takes generation (a string) and waitMs, 0 to 25000', isError: true };
      const messages = await outbox.poll(
        ferret,
        parsed.data.generation,
        Math.min(parsed.data.waitMs ?? CHANNEL_POLL_MAX_WAIT_MS, CHANNEL_POLL_MAX_WAIT_MS),
      );
      return {
        text: messages.length === 0 ? 'no messages' : `${String(messages.length)} message(s)`,
        data: { messages: messages.map(message => ({ ...message })) },
      };
    },
    channel_claim: async (call, input) => {
      const ferret = ferretOf(call);
      if (ferret === undefined) return { text: NOT_A_FERRET, isError: true };
      const parsed = ChannelClaimInputSchema.safeParse(input);
      if (!parsed.success) return { text: 'channel_claim takes generation and sendId', isError: true };
      const claimed = outbox.claim(ferret, parsed.data.generation, parsed.data.sendId);
      return {
        text: claimed ? 'claimed' : 'not claimed',
        data: { claimed, writeBudgetMs: CHANNEL_WRITE_BUDGET_MS },
      };
    },
  };
}
