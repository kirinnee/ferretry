import { milliseconds } from '@ferretry/std';
import { channelTools } from '../channel/index.ts';
import { ChannelOutbox } from '../channel/lib/outbox.ts';
import type { ConversationFeature } from './types.ts';

/**
 * THE CLAUDE CHANNEL'S OUTBOX: what waits to be forwarded into a Claude ferret's session by the MCP server it already
 * runs, and whether that server is listening. A ferret's or the daemon's message goes through it instead of the composer
 * (the Mailbox's send path); the tracker proves it from the transcript and types it ONCE if nothing arrived. The agent
 * tools its MCP server pumps the channel with are served here; the queue feature hands the outbox to the Mailbox.
 */
export default {
  id: 'channel',
  register: f => {
    const { kernel } = f;
    const outbox = new ChannelOutbox({
      nowMs: () => kernel.clock.nowMs(),
      after: (ms, run) => kernel.clock.after(milliseconds(ms), run),
    });
    f.late.channelOutbox = outbox;
    return { tools: channelTools(outbox), stop: () => outbox.stop() };
  },
} satisfies ConversationFeature;
