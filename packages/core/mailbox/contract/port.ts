import { definePort } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type {
  ComposerResult,
  FerretQueue,
  InterruptRequest,
  QueueEditRequest,
  QueuedMessage,
  SendListResponse,
  SendRecord,
  SendRequest,
  SendResult,
} from './wire-send.ts';

/** Why the Mailbox refused (the code is the route's `code`; `status` is its HTTP status). */
export interface MailboxRefusal {
  readonly code: string;
  readonly message: string;
}

/**
 * Who is calling a write: the owner, a ferret (named), or the Warden. Gate stamps the caller of a ROUTE; a caller of
 * THIS port is bound by the kernel instead: the provider binds each consumer from its own manifest id, and `warden` is accepted only from the Warden's plugin (`agenda`, only from Agenda's). Any
 * other consumer naming it is refused `forbidden` before anything is read or typed.
 * `warden` (additive, D2 #19) is Ferretry's own watchdog speaking: its words are typed bare, recorded as the DAEMON's
 * (`senderKind: 'daemon'`, `by` Ferretry's Warden), never as the owner's own message and never as a ferret's:
 * a notice is not kept, retried or counted as the owner's.
 * `agenda` is the same for Agenda's turn-end check (its nudge words, built inside Agenda from fixed text): accepted only
 * from the Agenda's plugin, typed bare and recorded as the DAEMON's (`senderKind: 'daemon'`, by Ferretry's Agenda).
 */
export type MailboxCaller =
  | { readonly kind: 'owner' }
  | { readonly kind: 'ferret'; readonly ferret: FerretId }
  | { readonly kind: 'warden' }
  | { readonly kind: 'agenda' };

/**
 * What other plugins and the app ask of the Mailbox (§2.3): every message to a ferret, the queue it waits in, the send
 * ledger that proves it, and the person's composer draft. Conversation's port carries all of it unchanged
 * (`ConversationApi extends MailboxApi`).
 */
export interface MailboxQueueApi {
  queue(ferret: FerretId): Promise<FerretQueue>;
  editQueued(
    ferret: FerretId,
    message: string,
    request: QueueEditRequest,
  ): Promise<Result<QueuedMessage, MailboxRefusal>>;
  cancelQueued(ferret: FerretId, message: string): Promise<Result<QueuedMessage, MailboxRefusal>>;
}

/** The whole of the Mailbox's API: the queue's half ({@link MailboxQueueApi}) and the send path's. */
export interface MailboxApi extends MailboxQueueApi {
  send(ferret: FerretId, caller: MailboxCaller, request: SendRequest): Promise<Result<SendResult, MailboxRefusal>>;
  interrupt(ferret: FerretId, request: InterruptRequest): Promise<Result<void, MailboxRefusal>>;
  sends(ferret: FerretId, cursor?: string): Promise<SendListResponse>;
  sendRecord(ferret: FerretId, sendId: string): Promise<SendRecord | undefined>;
  retrySend(ferret: FerretId, sendId: string, force?: boolean): Promise<Result<SendRecord, MailboxRefusal>>;
  /**
   * Cancels a send's leftover typing (the route's `POST …/sends/:sendId/cancel`). The Warden's alone: any other consumer
   * is refused `forbidden` (see {@link MailboxCaller}).
   */
  cancelSend(ferret: FerretId, sendId: string): Promise<Result<SendRecord, MailboxRefusal>>;
  /** One Enter for a send's own text (the route's `…/enter`), with the rules of {@link cancelSend}. */
  enterSend(ferret: FerretId, sendId: string): Promise<Result<SendRecord, MailboxRefusal>>;
  /**
   * Acts on the person's composer draft (the route's `POST …/composer`). The route is person-only and gated by
   * `terminal.use`; a port consumer carries no such call, so the port serves the Warden alone and refuses any other
   * consumer `forbidden`.
   */
  composer(
    ferret: FerretId,
    action: 'submit' | 'clear',
    draft: string,
  ): Promise<Result<ComposerResult, MailboxRefusal>>;
  /**
   * Additive (send path, today's `SessionSendService.resubmitStuck`): the Warden's ONE verified Enter on a send's own text
   * left typed in a ferret's composer. It presses only when the composer holds exactly that send's text at an idle,
   * undialogued pane, and no more than one Enter past the send path's own bound. `submitted` / `holding` say what the
   * Enter did, `absent` that the box is empty (the message is not sitting there), `refused` that nothing was pressed.
   * Only the `warden` caller may ask: any other is refused `forbidden` before a pane is read.
   */
  resubmitStuck?(
    ferret: FerretId,
    caller: MailboxCaller,
    sendId: string,
  ): Promise<Result<'submitted' | 'holding' | 'absent' | 'refused', MailboxRefusal>>;
  /**
   * Additive (send path, &B153): the id of the delivered pointer the harness took back into the ferret's box, when an idle,
   * undialogued pane shows exactly it. Reads the pane and presses nothing; `undefined` when none (or the pane cannot be read).
   */
  retractedDraft?(ferret: FerretId): Promise<string | undefined>;
}

/** What the Mailbox serves: its queue and the send path. */
export const MailboxPort = definePort<MailboxApi>('mailbox');
