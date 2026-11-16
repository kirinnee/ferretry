import { ferretOf } from '@ferretry/core-gate/contract';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import {
  ChannelAckInputSchema,
  ChannelPollInputSchema,
  CHANNEL_POLL_MAX_WAIT_MS,
} from '../../contract/wire-channel.ts';
import type { ChannelOutbox } from './lib/outbox.ts';

const NOT_A_FERRET =
  'The channel belongs to a ferret: run this from inside a ferret, with the credential Ferretry gives each one.';

/**
 * The two agent tools the Claude MCP server pumps its channel with, as the session that called them. The caller is the
 * ferret the credential names; nothing in the arguments can name another one.
 */
export function channelTools(outbox: ChannelOutbox): {
  readonly channel_poll: ToolHandler;
  readonly channel_ack: ToolHandler;
} {
  return {
    channel_poll: async (call, input) => {
      const ferret = ferretOf(call);
      if (ferret === undefined) return { text: NOT_A_FERRET, isError: true };
      const parsed = ChannelPollInputSchema.safeParse(input ?? {});
      if (!parsed.success) return { text: 'channel_poll takes waitMs, 0 to 25000', isError: true };
      const messages = await outbox.poll(
        ferret,
        Math.min(parsed.data.waitMs ?? CHANNEL_POLL_MAX_WAIT_MS, CHANNEL_POLL_MAX_WAIT_MS),
      );
      return {
        text: messages.length === 0 ? 'no messages' : `${String(messages.length)} message(s)`,
        data: { messages: messages.map(message => ({ ...message })) },
      };
    },
    channel_ack: async (call, input) => {
      const ferret = ferretOf(call);
      if (ferret === undefined) return { text: NOT_A_FERRET, isError: true };
      const parsed = ChannelAckInputSchema.safeParse(input);
      if (!parsed.success) return { text: 'channel_ack takes sendIds, one to 100', isError: true };
      const acked = outbox.ack(ferret, parsed.data.sendIds);
      return { text: `${String(acked)} acknowledged`, data: { acked } };
    },
  };
}
