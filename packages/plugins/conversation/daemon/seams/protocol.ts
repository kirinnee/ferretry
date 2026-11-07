/**
 * The wire names the ported send, queue, question, turn and draft code was written against, over this package's
 * contract. Where the contract renamed a thing to the words (§1: ferret, message, draft), the old name is still
 * exported here as an alias so the copied bodies read as they did; nothing here is a second definition.
 */
import type { z } from 'zod';
import {
  AnswerRequestSchema,
  type CompactAtPatchResult,
  CompactAtPatchSchema,
  ComposerRequestSchema,
  ComposerResultSchema,
  DRAFT_ERROR_CODES,
  DRAFT_HISTORY_LIMIT,
  DRAFT_ITEMS_BUDGET,
  DRAFT_MAX_CHARS,
  DRAFT_MAX_ITEM_DRAFTS,
  DRAFT_MAX_ITEMS,
  DRAFT_SCHEMA_VERSION,
  DRAFT_STREAM_FRAME_BUDGET,
  DRAFT_STREAM_RESYNC_CLOSE,
  type DraftClientFrame,
  DraftClientFrameSchema,
  type DraftEdit,
  DraftEditSchema,
  type DraftEditResult,
  type DraftItem,
  type DraftSent,
  type DraftServerFrame,
  type DraftSlot,
  type DraftSnapshot,
  DraftSnapshotSchema,
  type FerretCompactAt,
  HandoffNameSchema,
  InterruptRequestSchema,
  type SendCancelEffectSchema,
  type SendDispositionSchema,
  SendRequestSchema,
  REQUEST_ID_HEADER,
  type SenderKind,
  draftFrameBytes,
  isDraftItemSlot,
} from '../../contract/index.ts';

export * from '../../contract/index.ts';

// ── the old names, over the new ones ────────────────────────────────────────────────────────────────
export const AnswerSessionRequestSchema = AnswerRequestSchema;
export const ComposerDraftRequestSchema = ComposerRequestSchema;
export type ComposerDraftRequest = z.infer<typeof ComposerRequestSchema>;

export type ComposerDraftResult = z.infer<typeof ComposerResultSchema>;
export const InterruptSessionRequestSchema = InterruptRequestSchema;
export const SendSubmitRequestSchema = SendRequestSchema;

export type SendSenderKind = SenderKind;

export type SendCancelEffect = z.infer<typeof SendCancelEffectSchema>;
export type SendDisposition = z.infer<typeof SendDispositionSchema>;
export type SendQueueProof = 'transcript' | 'pane';

export type SessionCompactAt = FerretCompactAt;
export const SessionCompactAtPatchSchema = CompactAtPatchSchema;

export type SessionCompactAtPatchResult = CompactAtPatchResult;
export const SessionHandoffNameSchema = HandoffNameSchema;

// shared draft → draft
export const SHARED_DRAFT_ERROR_CODES = DRAFT_ERROR_CODES;
export const SHARED_DRAFT_HISTORY_LIMIT = DRAFT_HISTORY_LIMIT;
export const SHARED_DRAFT_ITEMS_BUDGET = DRAFT_ITEMS_BUDGET;
export const SHARED_DRAFT_MAX_CHARS = DRAFT_MAX_CHARS;
export const SHARED_DRAFT_MAX_ITEMS = DRAFT_MAX_ITEMS;
export const SHARED_DRAFT_MAX_ITEM_DRAFTS = DRAFT_MAX_ITEM_DRAFTS;
export const SHARED_DRAFT_SCHEMA_VERSION = DRAFT_SCHEMA_VERSION;
export const SHARED_DRAFT_STREAM_FRAME_BUDGET = DRAFT_STREAM_FRAME_BUDGET;
export const SHARED_DRAFT_STREAM_RESYNC_CLOSE = DRAFT_STREAM_RESYNC_CLOSE;
export const sharedDraftFrameBytes = draftFrameBytes;
export const isSharedDraftItemSlot = isDraftItemSlot;
export type SharedDraftSlot = DraftSlot;
export type SharedDraftItem = DraftItem;
export type SharedDraftSnapshot = DraftSnapshot;
export const SharedDraftSnapshotSchema = DraftSnapshotSchema;
export type SharedDraftEdit = DraftEdit;
export const SharedDraftEditSchema = DraftEditSchema;
export type SharedDraftEditResult = DraftEditResult;
export type SharedDraftSent = DraftSent;
export type SharedDraftClientFrame = DraftClientFrame;
export const SharedDraftClientFrameSchema = DraftClientFrameSchema;
export type SharedDraftServerFrame = DraftServerFrame;

export const FY_REQUEST_ID_HEADER = REQUEST_ID_HEADER;
export * from './ferret-types.ts';
export type {
  HandoffDocument as SessionHandoff,
  HandoffAttachment as SessionHandoffAttachment,
} from '../../contract/index.ts';
