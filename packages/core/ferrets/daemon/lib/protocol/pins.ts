import { z } from 'zod';
import { MAX_PIN_NOTE_LENGTH, PinBlockKindSchema, PinPreviewSchema, PinSchema } from '../../../contract/pins.ts';

/**
 * The pin documents' stored shapes are the contract's (`contract/pins.ts`); this module keeps the daemon's own
 * limits, snapshot and request vocabulary, and re-exports the moved names so its readers are unchanged.
 */
export {
  MAX_PIN_NOTE_LENGTH,
  MAX_PIN_PREVIEW_LENGTH,
  type Pin,
  type PinBlockKind,
  type PinBy,
} from '../../../contract/pins.ts';

/** An ISO instant as the wire spells it (today's `InstantSchema`: kept as written, not re-branded). */
const InstantSchema = z.iso.datetime({ offset: true });

export const PIN_SCHEMA_VERSION = 1 as const;
export const MAX_PINS_PER_SESSION = 20;

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
