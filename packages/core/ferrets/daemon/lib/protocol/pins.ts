import { z } from 'zod';
import { MAX_PIN_NOTE_LENGTH, type Pin, PinBlockKindSchema, PinPreviewSchema } from '../../../contract/pins.ts';

/**
 * The pin documents' stored shapes are the contract's (`contract/pins.ts`); this module keeps the daemon's own
 * limits, snapshot and request vocabulary, and re-exports the moved names so its readers are unchanged.
 */
export { MAX_PIN_NOTE_LENGTH, MAX_PIN_PREVIEW_LENGTH, type Pin } from '../../../contract/pins.ts';

/** An ISO instant as the wire spells it (today's `InstantSchema`: kept as written, not re-branded). */
const InstantSchema = z.iso.datetime({ offset: true });

export const PIN_SCHEMA_VERSION = 1 as const;
export const MAX_PINS_PER_SESSION = 20;

/**
 * One ferret's pins as a read answers them. A shape, not a parser: no 5.0 code parses a snapshot. Pin ids and message
 * block ids stay unique because every pin enters through `normalizedPins` (`../pins/policy.ts`), on a read of the stored
 * file and on every write.
 */
export interface PinSnapshot {
  readonly v: typeof PIN_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly pins: Pin[];
  readonly updatedAt: string;
}

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
