import { z } from 'zod';
import { InstantSchema, PositiveIntegerSchema } from './common.ts';

export const PIN_SCHEMA_VERSION = 1 as const;
export const MAX_PINS_PER_SESSION = 20;
export const MAX_PIN_NOTE_LENGTH = 500;
export const MAX_PIN_PREVIEW_LENGTH = 200;

export const PinBySchema = z.enum(['human', 'agent']);
export type PinBy = z.infer<typeof PinBySchema>;

export const PinBlockKindSchema = z.enum(['user', 'assistant', 'thinking', 'tools', 'system', 'notice']);
export type PinBlockKind = z.infer<typeof PinBlockKindSchema>;

const PinPreviewSchema = z
  .string()
  .max(MAX_PIN_PREVIEW_LENGTH)
  .regex(/^[^\r\n]*$/u, 'preview must be a single line');

const PinIdentityShape = {
  id: z.uuid(),
  at: PositiveIntegerSchema,
};

const PinProvenanceSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('human'), createdBy: z.null(), createdByName: z.null() }),
  z.object({ by: z.literal('agent'), createdBy: z.string().min(1), createdByName: z.string().nullable() }),
]);

export const MessagePinSchema = z.intersection(
  z.object({
    ...PinIdentityShape,
    kind: z.literal('message'),
    blockId: z.string().min(1),
    blockKind: PinBlockKindSchema,
    preview: PinPreviewSchema,
    ts: InstantSchema.optional(),
  }),
  PinProvenanceSchema,
);
export type MessagePin = z.infer<typeof MessagePinSchema>;

export const NotePinSchema = z.intersection(
  z.object({
    ...PinIdentityShape,
    kind: z.literal('note'),
    text: z.string().min(1).max(MAX_PIN_NOTE_LENGTH),
    source: z.object({ blockId: z.string().min(1) }).optional(),
  }),
  PinProvenanceSchema,
);
export type NotePin = z.infer<typeof NotePinSchema>;

export const PinSchema = z.union([MessagePinSchema, NotePinSchema]);
export type Pin = z.infer<typeof PinSchema>;

export const PinSnapshotSchema = z
  .object({
    v: z.literal(PIN_SCHEMA_VERSION),
    sessionId: z.string().min(1),
    pins: z.array(PinSchema).max(MAX_PINS_PER_SESSION),
    updatedAt: InstantSchema,
  })
  .superRefine((value, context) => {
    if (new Set(value.pins.map(pin => pin.id)).size !== value.pins.length) {
      context.addIssue({ code: 'custom', message: 'pin ids must be unique', path: ['pins'] });
    }
    const messageBlockIds = value.pins.filter(pin => pin.kind === 'message').map(pin => pin.blockId);
    if (new Set(messageBlockIds).size !== messageBlockIds.length) {
      context.addIssue({ code: 'custom', message: 'message block ids must be unique', path: ['pins'] });
    }
  });
export type PinSnapshot = z.infer<typeof PinSnapshotSchema>;

const AddPinRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    action: z.literal('add'),
    kind: z.literal('note'),
    text: z.string().min(1).max(MAX_PIN_NOTE_LENGTH),
    source: z.strictObject({ blockId: z.string().min(1) }).optional(),
  }),
  z.strictObject({
    action: z.literal('add'),
    kind: z.literal('message'),
    blockId: z.string().min(1),
    blockKind: PinBlockKindSchema,
    preview: PinPreviewSchema,
    ts: InstantSchema.optional(),
  }),
]);

export const PinActionRequestSchema = z.union([
  AddPinRequestSchema,
  z.strictObject({
    action: z.literal('edit'),
    id: z.uuid(),
    text: z.string().min(1).max(MAX_PIN_NOTE_LENGTH),
  }),
  z.strictObject({ action: z.literal('remove'), id: z.uuid() }),
]);
export type PinActionRequest = z.infer<typeof PinActionRequestSchema>;

export const PinErrorCodeSchema = z.enum([
  'invalid',
  'too-long',
  'not-found',
  'forbidden',
  'rate-limited',
  'read-only',
]);
export type PinErrorCode = z.infer<typeof PinErrorCodeSchema>;
