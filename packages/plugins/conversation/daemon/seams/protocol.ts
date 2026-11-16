/**
 * The wire names the ported send, queue, question, turn and draft code was written against, over this package's
 * contract. Where the contract renamed a thing to the words (§1: ferret, message, draft), the old name is still
 * exported here as an alias so the copied bodies read as they did; nothing here is a second definition.
 */
import {
  AnswerRequestSchema,
  type CompactAtPatchResult,
  CompactAtPatchSchema,
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
  type DraftServerFrame,
  type DraftSlot,
  type DraftSnapshot,
  DraftSnapshotSchema,
  type FerretCompactAt,
  draftFrameBytes,
  isDraftItemSlot,
} from '../../contract/index.ts';

export * from '../../contract/index.ts';

// ── the old names, over the new ones ────────────────────────────────────────────────────────────────
export const AnswerSessionRequestSchema = AnswerRequestSchema;

export type SessionCompactAt = FerretCompactAt;
export const SessionCompactAtPatchSchema = CompactAtPatchSchema;

export type SessionCompactAtPatchResult = CompactAtPatchResult;

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
export type SharedDraftClientFrame = DraftClientFrame;
export const SharedDraftClientFrameSchema = DraftClientFrameSchema;
export type SharedDraftServerFrame = DraftServerFrame;
