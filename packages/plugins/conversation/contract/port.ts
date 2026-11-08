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
 * Who is calling a write: the owner, a ferret (named), or the Warden. Gate stamped it; Conversation never decides it.
 * `warden` (additive, D2 #19) is Ferretry's own watchdog speaking: its words are typed bare, recorded as the DAEMON's
 * (`senderKind: 'daemon'`, authored by Ferretry's Warden), never as the owner's own message and never as a ferret's:
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
  cancelSend(ferret: FerretId, sendId: string): Promise<Result<SendRecord, ConversationRefusal>>;
  enterSend(ferret: FerretId, sendId: string): Promise<Result<SendRecord, ConversationRefusal>>;
  composer(
    ferret: FerretId,
    action: 'submit' | 'clear',
    draft: string,
  ): Promise<Result<ComposerResult, ConversationRefusal>>;

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
