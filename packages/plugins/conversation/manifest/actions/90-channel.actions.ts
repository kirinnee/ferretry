/** The Claude channel pump of `fy mcp serve` (contract/wire-channel.ts): two agent tools. */
import { tool } from '@ferretry/kernel/manifest';
import { cap, ChannelClaimInputSchema, ChannelPollInputSchema } from '../../contract/index.ts';
import { fragment } from '../kit.ts';

export default fragment({
  agentTools: [
    // Called as the session by the server itself, never listed to a model. Polled every few seconds for the life of a
    // ferret, so neither is audit-recorded.
    tool('channel_poll', {
      minimum: 'authenticated',
      caller: 'any',
      capability: cap('fleet', 'use'),
      audit: { skip: 'read' },
      guard: { none: 'the messages already shown to the ferret, as typed' },
      summary: 'The channel pump: wait for messages to forward into this Claude session.',
      input: ChannelPollInputSchema,
    }),
    tool('channel_claim', {
      minimum: 'authenticated',
      caller: 'any',
      capability: cap('fleet', 'use'),
      audit: { skip: 'not recorded: bookkeeping for a message the daemon already ledgered' },
      guard: { none: 'ids only' },
      summary:
        'The channel pump: claim one polled message before writing it to this Claude session (granted only while it is not withdrawn).',
      input: ChannelClaimInputSchema,
    }),
  ],
});
