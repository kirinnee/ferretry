/**
 * THE CHANNEL — how a message from another ferret, or from Ferretry itself, reaches a Claude Code ferret without
 * being typed into its composer.
 *
 * Claude Code accepts a push from an MCP server that declares `capabilities.experimental['claude/channel']` and sends
 * `notifications/claude/channel` with `{ content, meta }` (launched with `--dangerously-load-development-channels
 * server:ferretry`, which the fixed layer adds). Measured on 2.1.317: delivered in milliseconds to an idle session and
 * at the next tool boundary to a busy one, in order, none lost. The conversation's own words are Conversation's: this
 * module only carries them. It holds NO queue of its own and decides nothing about delivery.
 *
 * HOW IT TALKS TO THE DAEMON. Over the tool door, as the session, like every other call this server makes:
 * `channel_poll` is a long poll that answers as soon as a message is waiting for THIS session (and, by being in flight,
 * is how the daemon knows the channel is connected), and `channel_ack` says which messages were handed to Claude. Neither
 * is in the tools list a model sees; this module is their only caller.
 *
 * A FAILURE NEVER STOPS IT. A poll that fails (the daemon restarting, a refused call) backs off, capped, and tries
 * again; a notification is written before it is acked, so a message is never acked that Claude was not handed.
 */
import { z } from 'zod';

/** One message the daemon holds for this session: its id, the exact text to hand Claude (banner included) and who sent it. */
export interface ChannelMessage {
  readonly sendId: string;
  readonly text: string;
  readonly from?: string;
}

/** What the pump needs from the daemon. */
export interface ChannelPort {
  /** Messages waiting for this session; waits up to `waitMs` for the first one. */
  poll(waitMs: number): Promise<readonly ChannelMessage[]>;
  /** Tells the daemon these were handed to Claude. */
  ack(sendIds: readonly string[]): Promise<void>;
}

/** How long one poll waits at the daemon: under the tool door's own limit, so no request outlives the transport. */
export const CHANNEL_POLL_WAIT_MS = 20_000;
/** The first and the longest wait after a failed poll. */
export const CHANNEL_BACKOFF_START_MS = 2_000;
export const CHANNEL_BACKOFF_MAX_MS = 30_000;

/**
 * What the model is told about the channel (MCP `initialize` instructions). Plain on purpose: a busy model once ignored
 * channel messages as "not from the user", so this says whose they are and that they are work.
 */
export const CHANNEL_INSTRUCTIONS =
  'Messages inside <channel source="ferretry"> come from Ferretry and from other ferrets, not from the owner. Act on them ' +
  'as work messages from those senders: each carries its sender banner. The owner’s own words arrive as normal prompts, ' +
  'never through the channel.';

/** The poll's answer, as the tool door gives it. Loose: a field the daemon adds later is not this port's to refuse. */
const PollSchema = z.looseObject({
  messages: z.array(z.looseObject({ sendId: z.string().min(1), text: z.string(), from: z.string().min(1).optional() })),
});

/** Reads the daemon's `channel_poll` answer (`data`), or nothing when it is not that shape. */
export function parseChannelMessages(data: unknown): readonly ChannelMessage[] | undefined {
  const parsed = PollSchema.safeParse(data);
  if (!parsed.success) return undefined;
  return parsed.data.messages.map(message => ({
    sendId: message.sendId,
    text: message.text,
    ...(message.from === undefined ? {} : { from: message.from }),
  }));
}

/** One channel notification as a line of JSON-RPC. The meta never has a `source` key: it would collide with the tag's own. */
export function channelNotification(message: ChannelMessage): string {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: {
      content: message.text,
      meta: { send_id: message.sendId, ...(message.from === undefined ? {} : { from: message.from }) },
    },
  })}\n`;
}

export interface ChannelSeams {
  /** Resolves after `ms`; the pump's only clock. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Said when a poll or an ack failed (the daemon's own sentence); never throws. */
  readonly onError?: (message: string) => void;
}

/** Forwards the daemon's channel messages for this session to Claude, until stopped. */
export class ChannelPump {
  private running = false;
  private stopped = false;

  constructor(
    private readonly port: ChannelPort,
    private readonly write: (line: string) => void,
    private readonly seams: ChannelSeams,
  ) {}

  /** Starts the loop once; a second call (a client that sends `initialized` twice) is ignored. Resolves when stopped. */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    return this.loop();
  }

  /** Ends the loop after the poll now in flight. */
  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    let backoff = CHANNEL_BACKOFF_START_MS;
    while (!this.stopped) {
      let messages: readonly ChannelMessage[];
      try {
        messages = await this.port.poll(CHANNEL_POLL_WAIT_MS);
      } catch (error) {
        this.seams.onError?.(`channel poll failed: ${error instanceof Error ? error.message : String(error)}`);
        await this.seams.sleep(backoff);
        backoff = Math.min(backoff * 2, CHANNEL_BACKOFF_MAX_MS);
        continue;
      }
      backoff = CHANNEL_BACKOFF_START_MS;
      if (this.stopped || messages.length === 0) continue;
      for (const message of messages) this.write(channelNotification(message));
      try {
        await this.port.ack(messages.map(message => message.sendId));
      } catch (error) {
        this.seams.onError?.(`channel ack failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
