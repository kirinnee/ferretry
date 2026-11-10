import { definePort } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { AnswerRequest, Question } from './wire-question.ts';
import type {
  AttachmentDownload,
  AttachmentUploadRequest,
  AttachmentView,
  RenderBody,
  RenderMeta,
  RenderSaveRequest,
  RenderSaveResponse,
} from './wire-media.ts';
import type { DraftEdit, DraftEditResult, DraftSlot, DraftSnapshot } from './wire-draft.ts';
import type { KeepRequest, KeepResult, LinkListing, LinkPreview, LinkQuery } from './wire-link.ts';
import type {
  LogPage,
  LogPageOptions,
  LogSearch,
  LogSearchOptions,
  MessagesTailOptions,
  OwnerWords,
  OwnerWordsOptions,
  TranscriptEventsOptions,
  TranscriptEventTail,
  TranscriptLogTail,
  TranscriptPage,
} from './wire-read.ts';
import type { WorkRelatedRequest, WorkRelatedResponse, WorkSearchQuery, WorkSearchResponse } from './wire-search.ts';
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
import type { CompactAtPatch, CompactAtPatchResult, FerretCompactAt } from './wire-compact.ts';

/** Why Conversation refused (the code is the route's `code`; `status` is its HTTP status). */
export interface ConversationRefusal {
  readonly code: string;
  readonly message: string;
}

/**
 * Who is calling a write: the owner, a ferret (named), or the Warden. Gate stamps the caller of a ROUTE; a caller of
 * THIS port is bound by the kernel instead: Conversation provides through `perNeeder`, so each consumer holds a facade
 * built from its own manifest id ({@link conversationFor}), and `warden` is accepted only from the Warden's plugin. Any
 * other consumer naming it is refused `forbidden` before anything is read or typed.
 * `warden` (additive, D2 #19) is Ferretry's own watchdog speaking: its words are typed bare, recorded as the DAEMON's
 * (`senderKind: 'daemon'`, `by` Ferretry's Warden), never as the owner's own message and never as a ferret's:
 * a notice is not kept, retried or counted as the owner's.
 */
export type ConversationCaller =
  | { readonly kind: 'owner' }
  | { readonly kind: 'ferret'; readonly ferret: FerretId }
  | { readonly kind: 'warden' };

/**
 * What other plugins and the app read and ask of Conversation (§2.3): messages, the queue, turns, questions,
 * attachments, renders, drafts, search and links. Warden, Usage and Lessons need only `currentTurn`.
 */
export interface ConversationApi {
  /** The id of the turn a ferret is in the middle of, if any. */
  currentTurn(ferret: FerretId): Promise<string | undefined>;

  // messages and the queue
  send(
    ferret: FerretId,
    caller: ConversationCaller,
    request: SendRequest,
  ): Promise<Result<SendResult, ConversationRefusal>>;
  interrupt(ferret: FerretId, request: InterruptRequest): Promise<Result<void, ConversationRefusal>>;
  queue(ferret: FerretId): Promise<FerretQueue>;
  editQueued(
    ferret: FerretId,
    message: string,
    request: QueueEditRequest,
  ): Promise<Result<QueuedMessage, ConversationRefusal>>;
  cancelQueued(ferret: FerretId, message: string): Promise<Result<QueuedMessage, ConversationRefusal>>;
  sends(ferret: FerretId, cursor?: string): Promise<SendListResponse>;
  sendRecord(ferret: FerretId, sendId: string): Promise<SendRecord | undefined>;
  retrySend(ferret: FerretId, sendId: string, force?: boolean): Promise<Result<SendRecord, ConversationRefusal>>;
  /**
   * Cancels a send's leftover typing (the route's `POST …/sends/:sendId/cancel`). The Warden's alone: any other consumer
   * is refused `forbidden` (see {@link ConversationCaller}).
   */
  cancelSend(ferret: FerretId, sendId: string): Promise<Result<SendRecord, ConversationRefusal>>;
  /** One Enter for a send's own text (the route's `…/enter`), with the rules of {@link cancelSend}. */
  enterSend(ferret: FerretId, sendId: string): Promise<Result<SendRecord, ConversationRefusal>>;
  /**
   * Acts on the person's composer draft (the route's `POST …/composer`). The route is person-only and gated by
   * `terminal.use`; a port consumer carries no such call, so the port serves the Warden alone and refuses any other
   * consumer `forbidden`.
   */
  composer(
    ferret: FerretId,
    action: 'submit' | 'clear',
    draft: string,
  ): Promise<Result<ComposerResult, ConversationRefusal>>;
  /**
   * Additive (send path, today's `SessionSendService.resubmitStuck`): the Warden's ONE verified Enter on a send's own text
   * left typed in a ferret's composer. It presses only when the composer holds exactly that send's text at an idle,
   * undialogued pane, and no more than one Enter past the send path's own bound. `submitted` / `holding` say what the
   * Enter did, `absent` that the box is empty (the message is not sitting there), `refused` that nothing was pressed.
   * Only the `warden` caller may ask: any other is refused `forbidden` before a pane is read.
   */
  resubmitStuck?(
    ferret: FerretId,
    caller: ConversationCaller,
    sendId: string,
  ): Promise<Result<'submitted' | 'holding' | 'absent' | 'refused', ConversationRefusal>>;
  /**
   * Additive (send path, &B153): the id of the delivered pointer the harness took back into the ferret's box, when an idle,
   * undialogued pane shows exactly it. Reads the pane and presses nothing; `undefined` when none (or the pane cannot be read).
   */
  retractedDraft?(ferret: FerretId): Promise<string | undefined>;

  // reading
  transcript(
    ferret: FerretId,
    options?: MessagesTailOptions & { readonly cursor?: string },
  ): Promise<Result<TranscriptPage, ConversationRefusal>>;
  /**
   * The newest events of the ferret's transcript: messages, the tool calls it made and their results, oldest first. What
   * Board reads to see what a turn did. Refuses `not_found` when no transcript can be proved to be the ferret's.
   */
  transcriptEvents(
    ferret: FerretId,
    options?: TranscriptEventsOptions,
  ): Promise<Result<TranscriptEventTail, ConversationRefusal>>;
  /**
   * The same newest events as ONE text, EVERY kind rendered as the operator's log reads it (today's
   * `operatorReads.logs`), masked inside one redaction read. What the Warden fingerprints to see that a transcript
   * grew, a long think or a usage line included. Optional (additive); refuses as `transcriptEvents` does.
   */
  transcriptLog?(
    ferret: FerretId,
    options?: TranscriptEventsOptions,
  ): Promise<Result<TranscriptLogTail, ConversationRefusal>>;
  /**
   * What the owner said to the ferret, turn by turn, as far as the records say who wrote each. Strict refuses when a
   * record cannot be read (`unreadable`), where the default answers with what it could.
   */
  ownerWords(ferret: FerretId, options?: OwnerWordsOptions): Promise<Result<OwnerWords, ConversationRefusal>>;
  logPage(ferret: FerretId, options?: LogPageOptions): Promise<Result<LogPage, ConversationRefusal>>;
  logSearch(
    ferret: FerretId,
    query: string,
    options?: LogSearchOptions,
  ): Promise<Result<LogSearch, ConversationRefusal>>;

  // questions
  /** The question the ferret is waiting on, as the harness asked it; none when it asks nothing. */
  question(ferret: FerretId): Promise<Question | undefined>;
  answer(ferret: FerretId, request: AnswerRequest): Promise<Result<void, ConversationRefusal>>;

  // compaction
  compactAt(ferret: FerretId): Promise<FerretCompactAt | undefined>;
  setCompactAt(ferret: FerretId, patch: CompactAtPatch): Promise<Result<CompactAtPatchResult, ConversationRefusal>>;

  // attachments
  addAttachment(
    ferret: FerretId,
    upload: AttachmentUploadRequest,
  ): Promise<Result<AttachmentView, ConversationRefusal>>;
  attachment(ferret: FerretId, id: string): Promise<Result<AttachmentDownload, ConversationRefusal>>;
  unlockAttachment(
    ferret: FerretId,
    id: string,
    password: string,
  ): Promise<Result<AttachmentView, ConversationRefusal>>;
  relockAttachment(ferret: FerretId, id: string): Promise<Result<AttachmentView, ConversationRefusal>>;

  // renders
  saveRender(
    ferret: FerretId | undefined,
    request: RenderSaveRequest,
  ): Promise<Result<RenderSaveResponse, ConversationRefusal>>;
  renderMeta(id: string): Promise<RenderMeta | undefined>;
  render(id: string): Promise<RenderBody | undefined>;

  // drafts
  draft(ferret: FerretId, slot?: DraftSlot): Promise<DraftSnapshot>;
  editDraft(
    ferret: FerretId,
    slot: DraftSlot | undefined,
    edit: DraftEdit,
  ): Promise<Result<DraftEditResult, ConversationRefusal>>;

  // search
  searchWork(query: WorkSearchQuery): Promise<WorkSearchResponse>;
  related(request: WorkRelatedRequest): Promise<WorkRelatedResponse>;

  // links (§6.2)
  links(query: LinkQuery): Promise<LinkListing>;
  previewLink(harness: string, id: string): Promise<Result<LinkPreview, ConversationRefusal>>;
  keep(request: KeepRequest): Promise<KeepResult>;
}

export const ConversationPort = definePort<ConversationApi>('conversation');
