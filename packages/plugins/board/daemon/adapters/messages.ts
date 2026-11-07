import { type FerretsApi, FerretIdSchema } from '@ferretry/core-ferrets/contract';
import type { ConversationApi, SendResult } from '@ferretry/plugin-conversation/contract';
import type { BoardReopenAttachments } from '../../contract/index.ts';
import {
  type BoardAlertPorts,
  type FerretTranscriptTail,
  type HelperDirectory,
  nudgeTarget,
  type ReopenDelivery,
  type ReopenMessenger,
  type TranscriptEvent,
  type TranscriptTailResult,
} from '../lib/board/index.ts';

/**
 * Talking to a ferret: typing into its turn (or resuming it), reading its transcript. That is Conversation's, which
 * Board `uses` (optional, lead decision D2 #12); with Conversation off every message Board owes a ferret is HELD with a
 * warning — said in the log, never typed, and never pretended delivered (today's "held with a warning").
 */
export interface FerretMessenger {
  /** Sends one message to one ferret as the ordinary send path would; the same `key` twice is one message. */
  deliver: ReopenMessenger['deliver'];
  /** How the ferret takes messages; `undefined` when it cannot be read. */
  mode: BoardAlertPorts['mode'];
  /** The newest transcript events of a ferret. */
  tail: FerretTranscriptTail['tail'];
}

/** The sentence a ferret reads when the owner's files could not be copied to it: the message itself still lands. */
export const uncarriedFilesLine = (count: number): string =>
  `The owner also attached ${count === 1 ? 'a file' : `${count} files`} that could not be copied to this chat.`;

/** How many delivered keys are remembered, so the same message is not typed twice. */
const KEPT_KEYS = 1024;

/**
 * Board's messages through Conversation's ordinary send path, as the owner's (today's `SendReopenMessenger` and the
 * board's alert send). A helper is never the recipient: its lead is (`nudgeTarget`). Read late (`current`), so
 * Conversation turned on or off is followed without a restart.
 *
 * GAPS (Conversation's contract): `SendRequest` carries no send id, so "the same key twice is one message" holds only
 * within one daemon run (the keys are remembered here, not in Conversation's ledger); a held-back alert is not journalled
 * on the ferret (no journal write), only logged; and `transcript()` carries messages only, never tool calls, so the
 * transcript checks that read a turn's tool calls (a PR a ferret opened, the turn-end check) find none until
 * Conversation's transcript page carries them (needed additive read: tool-call events in the tail).
 */
export class ConversationMessages implements FerretMessenger {
  private readonly delivered = new Map<string, ReopenDelivery>();

  constructor(
    private readonly conversation: () => ConversationApi | undefined,
    private readonly ferrets: Pick<FerretsApi, 'get'>,
    private readonly helpers: HelperDirectory,
    private readonly diagnostics: { warn(message: string): void },
  ) {}

  async deliver(
    ferret: string,
    message: string,
    key: string,
    attachments?: BoardReopenAttachments,
  ): Promise<ReopenDelivery> {
    const known = this.delivered.get(key);
    if (known !== undefined) return known;
    const conversation = this.conversation();
    if (conversation === undefined) return this.held(ferret, message);
    const to = FerretIdSchema.safeParse(await nudgeTarget(this.helpers, ferret));
    if (!to.success) return 'absent';
    // Files go with the message only where they already are: carrying them between ferrets is not offered here.
    const carried = attachments === undefined || attachments.from === to.data;
    const text = carried ? message : `${message}\n\n${uncarriedFilesLine(attachments.ids.length)}`;
    try {
      const sent = await conversation.send(
        to.data,
        { kind: 'owner' },
        {
          message: text,
          ...(attachments !== undefined && carried ? { attachmentIds: [...attachments.ids] } : {}),
        },
      );
      if (!sent.ok) {
        this.diagnostics.warn(`a board message for ${to.data} was refused: ${sent.error.message}`);
        return 'absent';
      }
      const how = deliveryOf(sent.value);
      this.remember(key, how);
      return how;
    } catch (error) {
      this.diagnostics.warn(`a board message for ${to.data} was not sent: ${errorText(error)}`);
      return 'absent';
    }
  }

  /** The ordinary send of one board message (an alert, a nudge), keyed so it is typed once. Held when Conversation is off. */
  async send(ferret: string, message: string, key: string): Promise<void> {
    await this.deliver(ferret, message, key);
  }

  /** A board alert held back from an interactive ferret: logged (GAP: Conversation offers no journal write). */
  async withheld(ferret: string, message: string): Promise<void> {
    this.diagnostics.warn(`a board alert for ${ferret} was held back (the ferret is interactive): ${message}`);
  }

  async mode(ferret: string): Promise<'auto' | 'interactive' | undefined> {
    const id = FerretIdSchema.safeParse(ferret);
    if (!id.success) return undefined;
    return (await this.ferrets.get(id.data))?.mode;
  }

  async tail(ferret: string, limit: number): Promise<TranscriptTailResult> {
    const conversation = this.conversation();
    const id = FerretIdSchema.safeParse(ferret);
    if (conversation === undefined || !id.success) return { kind: 'unresolved' };
    try {
      const page = await conversation.transcript(id.data, { limit });
      if (!page.ok) return page.error.code === 'not_found' ? { kind: 'unresolved' } : { kind: 'unreadable' };
      const events: TranscriptEvent[] = page.value.messages.map(each => ({
        kind: 'message',
        role: each.role,
        text: each.text,
        ...(each.timestamp === undefined ? {} : { timestamp: each.timestamp }),
      }));
      return { kind: 'read', events };
    } catch {
      return { kind: 'unreadable' };
    }
  }

  private held(ferret: string, message: string): ReopenDelivery {
    this.diagnostics.warn(
      `a board message for ${ferret} was held: Conversation is off on this daemon, so it was not typed: ${message}`,
    );
    return 'absent';
  }

  private remember(key: string, how: ReopenDelivery): void {
    this.delivered.set(key, how);
    if (this.delivered.size > KEPT_KEYS) this.delivered.delete(this.delivered.keys().next().value as string);
  }
}

/** What Conversation did with a send, as the reopen ladder reads it. */
const deliveryOf = (sent: SendResult): ReopenDelivery =>
  sent.disposition === 'revived' ? 'resumed' : sent.disposition === 'queued-for-revive' ? 'held' : 'delivered';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
