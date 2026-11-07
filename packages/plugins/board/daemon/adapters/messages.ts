import { type FerretsApi, FerretIdSchema } from '@ferretry/core-ferrets/contract';
import { createHash } from 'node:crypto';
import type { ConversationApi, SendResult } from '@ferretry/plugin-conversation/contract';
import type { BoardReopenAttachments } from '../../contract/index.ts';
import {
  type BoardAlertPorts,
  type FerretTranscriptTail,
  type HelperDirectory,
  nudgeTarget,
  type ReopenDelivery,
  type ReopenMessenger,
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

/** The longest send id Conversation takes, and the characters its files and ids allow. */
const SEND_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

/**
 * The send id of one board message: the key itself when Conversation takes it as an id, else a name made of its digest.
 * The same key is always the same id, which is all "the same message twice is one message" asks of it: a done message's
 * key names every card in it, and could be longer than an id may be.
 */
export const sendIdOf = (key: string): string =>
  SEND_ID.test(key) ? key : `board-${createHash('sha256').update(key).digest('hex').slice(0, 48)}`;

/**
 * Board's messages through Conversation's ordinary send path, as the owner's (today's `SendReopenMessenger` and the
 * board's alert send). A helper is never the recipient: its lead is (`nudgeTarget`). Read late (`current`), so
 * Conversation turned on or off is followed without a restart.
 *
 * The key is the send's id (`SendRequest.sendId`), so "the same key twice is one message" holds across daemon runs: the
 * queue and Conversation's send ledger keep it, and nothing is remembered here. The transcript tail carries the tool
 * calls and results (`transcriptEvents`), so the checks that read a turn's tool calls (a PR a ferret opened, the turn-end
 * check) see them.
 *
 * GAP (Conversation's contract): a held-back alert is not journalled on the ferret (no journal write), only logged.
 */
export class ConversationMessages implements FerretMessenger {
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
          sendId: sendIdOf(key),
          ...(attachments !== undefined && carried ? { attachmentIds: [...attachments.ids] } : {}),
        },
      );
      if (!sent.ok) {
        this.diagnostics.warn(`a board message for ${to.data} was refused: ${sent.error.message}`);
        return 'absent';
      }
      return deliveryOf(sent.value);
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
      const page = await conversation.transcriptEvents(id.data, { limit });
      if (!page.ok) return page.error.code === 'not_found' ? { kind: 'unresolved' } : { kind: 'unreadable' };
      return { kind: 'read', events: page.value.events };
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
}

/** What Conversation did with a send, as the reopen ladder reads it. */
const deliveryOf = (sent: SendResult): ReopenDelivery =>
  sent.disposition === 'revived' ? 'resumed' : sent.disposition === 'queued-for-revive' ? 'held' : 'delivered';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
