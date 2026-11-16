import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { HarnessGate } from './lib/send/harness-seam.ts';
import type { SendEvidenceSource } from './lib/send/send-evidence.ts';
import type { SendChannel, SentDraftClearer } from './lib/send/types.ts';
import type { SendLedger, SessionQueueStore } from './stores.ts';

/** The stored original of one attachment of a ferret, its digest re-checked (Conversation's store). */
export interface AttachmentSource {
  download(
    ferret: string,
    id: string,
  ): Promise<{
    readonly attachment: { readonly id: string; readonly filename: string; readonly mime: string };
    readonly bytes: Uint8Array;
  }>;
}

/**
 * A Claude ferret's CHANNEL as the send path needs it: what waits to be pushed into the session by the MCP server it already
 * runs, and whether that server is listening. Conversation owns it (the outbox and the two tools the server pumps it with);
 * the send path routes a ferret's or the daemon's message through it instead of the composer, and the tracker proves the
 * push from the transcript.
 */
export interface ClaudeChannel {
  /** Whether this ferret's server is listening now and its channel has not been marked broken. */
  connected(ferret: string): boolean;
  /** Queues one message for the next poll. A send id already held is kept once. */
  push(ferret: string, message: { readonly sendId: string; readonly text: string; readonly from?: string }): void;
  /** When the server was granted the right to write this send (epoch ms); none when it was not (or the daemon forgot). */
  claimedAt(ferret: string, sendId: string): number | undefined;
  /** Takes a message back unless it was claimed; a claimed one may already be on its way to Claude. */
  withdraw(ferret: string, sendId: string): 'withdrawn' | 'claimed';
  /** A claimed message was never received: nothing more is routed through the channel until a new subscriber. */
  markBroken(ferret: string): void;
  /** The transcript showed Claude received this send. */
  received(ferret: string, sendId: string): void;
  /** Whether the channel was marked broken and has not had a new subscriber since. */
  broken(ferret: string): boolean;
  /** When this daemon began holding channel state (epoch ms). */
  readonly bootedAt: number;
  /** How long after sending its claim request the server may still write the message (the contract's write budget). */
  readonly writeBudgetMs: number;
  /** The sender as the channel tag names it, or none for neither a ferret nor the daemon. */
  senderName(
    speaker: { readonly senderSessionId?: string | undefined; readonly notice?: true; readonly agenda?: true },
    fromName: string | undefined,
  ): string | undefined;
}

/** The one key `mailbox.host` is provided under. */
export const MAILBOX_HOST_KEY = 'ferret' as const;

/**
 * What the Mailbox needs from the plugin that owns a ferret's files and terminals: where its queue and send ledger are
 * kept, the send's channel files, the transcript that proves a send, and the few facts only Conversation knows (a
 * pending question, the turn boundaries, the draft a send takes, `message.before-send`). Conversation declares and opens `queue.jsonl` and `sends.jsonl` under its own state folder (they never move), so
 * it hands the Mailbox a store and a ledger over them. The Mailbox never opens those files itself.
 *
 */
export interface MailboxHost {
  readonly queue: SessionQueueStore;
  readonly ledger: SendLedger;
  readonly channel: SendChannel;
  /** The transcript a send is proved by, for the ferret named. */
  readonly evidence: SendEvidenceSource;
  /** Which of the harness seam's two actions are live. */
  readonly gate: HarnessGate;
  /** The stored originals a send may name. Absent: a send that names a file is refused. */
  readonly attachments?: AttachmentSource;
  /** Where a stop marks the round it ended as interrupted (the turn boundaries, which Conversation keeps). */
  readonly boundaries: { markInterrupted(ferret: string): void };
  /** `question.json` as the question watch reads it: a send refuses while the ferret waits on one. */
  readonly askedQuestion: (ferret: string) => Promise<{ readonly toolUseId: string } | undefined>;
  /** One snapshot of the screen a stuck send met, written where the ferret's files are; the path it is kept at. */
  readonly keepFrame: (ferret: FerretId, frame: string) => Promise<string>;
  /** A cheap token for the log of `queue` or `sends` that moves with every line appended; `absent` when there is none. */
  readonly stamp: (log: 'queue' | 'sends', ferret: FerretId) => Promise<string>;
  /** `message.before-send`: the one place text enters a send, which a taker may reword or refuse. */
  readonly transformMessage: (input: {
    readonly ferret: FerretId;
    readonly text: string;
  }) => Promise<
    { readonly ok: true; readonly value: { readonly text: string } } | { readonly ok: false; readonly error: string }
  >;
  /** Takes what a send carried out of the owner's shared draft. Absent: the field is ignored. */
  readonly clearSentDraft?: SentDraftClearer;
  /** Claude's channel. Absent: every message is typed. */
  readonly claudeChannel?: ClaudeChannel;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** True when `value` carries a queue store and a send ledger (their methods are checked by the types, not at runtime). */
const isMailboxHost = (value: unknown): value is MailboxHost =>
  isObject(value) && isObject(value.queue) && isObject(value.ledger) && isObject(value.channel) && isObject(value.gate);

/**
 * `mailbox.host`: the Mailbox's one slot. A security-path provide hook (a message to an agent goes through it), so only
 * Conversation may take it. With no provider the Mailbox does not run a quiet empty store: it says so at boot and
 * answers every use with a refusal that names the cause (see the daemon half).
 */
export const MailboxHosts = defineHook('mailbox.host', {
  mode: 'provide',
  key: z.literal(MAILBOX_HOST_KEY),
  takers: ['conversation'],
  // A shape check, not a bare cast: a provider that hands over anything but a queue and a ledger is refused at provide time.
  value: z.custom<MailboxHost>(
    isMailboxHost,
    'a Mailbox host holds the queue, the send ledger and channel, and the gate',
  ),
});
