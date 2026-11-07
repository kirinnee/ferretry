/** The shared draft: one composer text kept in step across every open screen (today's `shared-draft.ts`). */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { FerretIdSchema } from './core.ts';

const NonNegativeInteger = z.number().int().nonnegative();

export const DRAFT_SCHEMA_VERSION = 1 as const;
/** The same bound the browser's own draft store has always had. */
export const DRAFT_MAX_CHARS = 16_000;
export const DRAFT_MAX_ITEMS = 20;
export const DRAFT_MAX_OP_COMPONENTS = 1_024;
/** Edits the daemon remembers to transform a late edit past; an older base must re-read the draft. */
export const DRAFT_HISTORY_LIMIT = 200;
export const DRAFT_MAX_ITEM_DRAFTS = 100;
export const DRAFT_STREAM_FRAME_BUDGET = 40_000;
export const DRAFT_ITEMS_BUDGET = 16_000;
export const DRAFT_EDIT_BUDGET = 32_000;
/** The close code that means "this stream could not carry a frame; read the whole draft again". */
export const DRAFT_STREAM_RESYNC_CLOSE = 4413;

const ID_MAX = 128;
const LABEL_MAX = 255;
const GENERATION_MAX = 64;

export const DRAFT_CHAT_SLOT = 'chat' as const;
/** Which of a ferret's drafts: its chat box (`chat`) or the reply under one ask on the agenda (that item's id, `A5`). */
export const DraftSlotSchema = z.union([z.literal(DRAFT_CHAT_SLOT), z.string().regex(/^A[1-9][0-9]*$/u)]);
export type DraftSlot = z.infer<typeof DraftSlotSchema>;

export type TextOpComponent = number | string;
export type TextOp = readonly TextOpComponent[];

const TextOpComponentSchema = z.union([
  z
    .number()
    .int()
    .refine(value => value !== 0, 'a retain or delete counts at least one character'),
  z.string().min(1).max(DRAFT_MAX_CHARS),
]);

/** A retain (n > 0), a delete (n < 0) or an insert (string), in order. The transform algebra is the port's. */
export const TextOpSchema = z
  .array(TextOpComponentSchema)
  .max(DRAFT_MAX_OP_COMPONENTS)
  .readonly()
  .refine(
    op =>
      op.reduce<number>((total, part) => total + (typeof part === 'string' ? part.length : 0), 0) <= DRAFT_MAX_CHARS,
    `an edit inserts at most ${DRAFT_MAX_CHARS} characters`,
  );

const IdSchema = z.string().min(1).max(ID_MAX);
const LabelSchema = z.string().min(1).max(LABEL_MAX);

export const DraftAttachmentSchema = z.strictObject({
  kind: z.literal('attachment'),
  id: IdSchema,
  name: LabelSchema,
  mime: LabelSchema,
  bytes: NonNegativeInteger,
});
export const DraftLocationSchema = z.strictObject({
  kind: z.literal('location'),
  id: IdSchema,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().nonnegative(),
  capturedAt: NonNegativeInteger,
  place: z.string().max(80).optional(),
});
export const DraftItemSchema = z.discriminatedUnion('kind', [DraftAttachmentSchema, DraftLocationSchema]);
export type DraftItem = z.infer<typeof DraftItemSchema>;

const GenerationSchema = z.string().min(1).max(GENERATION_MAX);

export const DraftSnapshotSchema = z.strictObject({
  v: z.literal(DRAFT_SCHEMA_VERSION),
  ferret: FerretIdSchema,
  slot: DraftSlotSchema.optional(),
  generation: GenerationSchema,
  epoch: NonNegativeInteger,
  rev: NonNegativeInteger,
  text: z.string().max(DRAFT_MAX_CHARS),
  items: z.array(DraftItemSchema).max(DRAFT_MAX_ITEMS).readonly(),
  updatedAt: InstantSchema,
});
export type DraftSnapshot = z.infer<typeof DraftSnapshotSchema>;

export const DraftEditSchema = z.strictObject({
  generation: GenerationSchema,
  epoch: NonNegativeInteger,
  base: NonNegativeInteger,
  text: TextOpSchema.optional(),
  add: z.array(DraftItemSchema).max(DRAFT_MAX_ITEMS).readonly().optional(),
  remove: z.array(IdSchema).max(DRAFT_MAX_ITEMS).readonly().optional(),
  sent: z.literal(true).optional(),
});
export type DraftEdit = z.infer<typeof DraftEditSchema>;

/** The part of a draft an accepted send carried out; taken out of the draft as one step with the send. */
export const DraftSentSchema = z.strictObject({
  slot: DraftSlotSchema.optional(),
  generation: GenerationSchema,
  epoch: NonNegativeInteger,
  base: NonNegativeInteger,
  text: TextOpSchema,
  remove: z.array(IdSchema).max(DRAFT_MAX_ITEMS).readonly().optional(),
});
export type DraftSent = z.infer<typeof DraftSentSchema>;

const AppliedSchema = z.strictObject({
  generation: GenerationSchema,
  epoch: NonNegativeInteger,
  rev: NonNegativeInteger,
  text: TextOpSchema,
  add: z.array(DraftItemSchema).readonly(),
  remove: z.array(IdSchema).readonly(),
});

export const DraftEditResultSchema = z.strictObject({ applied: AppliedSchema, snapshot: DraftSnapshotSchema });
export type DraftEditResult = z.infer<typeof DraftEditResultSchema>;

export const DRAFT_ERROR_CODES = {
  stale: 'shared_draft_stale',
  tooLong: 'shared_draft_too_long',
  tooManyItems: 'shared_draft_too_many_items',
  invalid: 'shared_draft_invalid',
  rateLimited: 'shared_draft_rate_limited',
  ownerOnly: 'shared_draft_owner_only',
  tooManyDrafts: 'shared_draft_too_many_drafts',
} as const;

const SelectionSchema = z.tuple([NonNegativeInteger, NonNegativeInteger]).readonly();
const PeerLabelSchema = z
  .string()
  .min(1)
  .max(LABEL_MAX)
  .regex(/^[^\r\n]*$/u, 'a device label is one line');
const EditIdSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(value => !value.includes('\u0000'), 'an edit id holds no NUL');
const UploadingSchema = z.array(PeerLabelSchema).max(DRAFT_MAX_ITEMS).readonly();

export const DraftClientFrameSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('edit'), id: EditIdSchema, edit: DraftEditSchema }),
  z.strictObject({
    kind: z.literal('presence'),
    typing: z.boolean(),
    selection: SelectionSchema.optional(),
    uploading: UploadingSchema.optional(),
  }),
]);
export type DraftClientFrame = z.infer<typeof DraftClientFrameSchema>;

export const DraftServerFrameSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('snapshot'),
    snapshot: DraftSnapshotSchema,
    more: z.number().int().positive().max(1_000).optional(),
  }),
  z.strictObject({ kind: z.literal('snapshot-text'), text: z.string().min(1).max(DRAFT_MAX_CHARS) }),
  z.strictObject({
    kind: z.literal('edit'),
    id: EditIdSchema.optional(),
    applied: AppliedSchema,
    epoch: NonNegativeInteger,
    rev: NonNegativeInteger,
  }),
  z.strictObject({ kind: z.literal('ready') }),
  z.strictObject({
    kind: z.literal('ack'),
    id: EditIdSchema,
    applied: AppliedSchema,
    epoch: NonNegativeInteger,
    rev: NonNegativeInteger,
  }),
  z.strictObject({
    kind: z.literal('error'),
    id: EditIdSchema,
    code: z.string().min(1).max(64),
    message: z.string().max(1_000),
  }),
  z.strictObject({
    kind: z.literal('presence'),
    peer: z.string().min(1).max(64),
    device: PeerLabelSchema,
    typing: z.boolean(),
    selection: SelectionSchema.optional(),
    uploading: UploadingSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('left'), peer: z.string().min(1).max(64) }),
]);
export type DraftServerFrame = z.infer<typeof DraftServerFrameSchema>;
