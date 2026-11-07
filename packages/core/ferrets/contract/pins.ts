import { PositiveIntegerSchema } from '@ferretry/std';
import { z } from 'zod';

/**
 * The stored shape of a ferret's pins (`state/ferrets/<ferret>/pins.json`, §9.2): moved here whole from the daemon so
 * the converter that writes the file and the daemon that reads it parse ONE definition.
 */

/** An ISO instant as the wire spells it (kept as written, not re-branded). */
const InstantSchema = z.iso.datetime({ offset: true });

export const MAX_PIN_NOTE_LENGTH = 500;
export const MAX_PIN_PREVIEW_LENGTH = 200;

const PinBySchema = z.enum(['human', 'agent']);
export type PinBy = z.infer<typeof PinBySchema>;

export const PinBlockKindSchema = z.enum(['user', 'assistant', 'thinking', 'tools', 'system', 'notice']);
export type PinBlockKind = z.infer<typeof PinBlockKindSchema>;

export const PinPreviewSchema = z
  .string()
  .max(MAX_PIN_PREVIEW_LENGTH)
  .regex(/^[^\r\n]*$/u, 'preview must be a single line');

export const PinIdentityShape = {
  id: z.uuid(),
  at: PositiveIntegerSchema,
};

const PinProvenanceSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('human'), createdBy: z.null(), createdByName: z.null() }),
  z.object({ by: z.literal('agent'), createdBy: z.string().min(1), createdByName: z.string().nullable() }),
]);

const MessagePinSchema = z.intersection(
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

const NotePinSchema = z.intersection(
  z.object({
    ...PinIdentityShape,
    kind: z.literal('note'),
    text: z.string().min(1).max(MAX_PIN_NOTE_LENGTH),
    source: z.object({ blockId: z.string().min(1) }).optional(),
  }),
  PinProvenanceSchema,
);

export const PinSchema = z.union([MessagePinSchema, NotePinSchema]);
export type Pin = z.infer<typeof PinSchema>;

/** The body of `state/ferrets/<ferret>/pins.json`: the ferret's note and message pins (the port stamps `format: 1`). */
export const FerretPinsDocumentSchema = z.strictObject({ pins: z.array(PinSchema) });
export type FerretPinsDocument = z.infer<typeof FerretPinsDocumentSchema>;

/** One pinned ferret: its id and the moment it was pinned, which is also its place in the list. */
const AgentPinSchema = z.strictObject({
  sessionId: z.string().min(1),
  pinnedAt: InstantSchema,
});
export type AgentPin = z.infer<typeof AgentPinSchema>;

/** The body of `state/ferrets/agent-pins.json`: the owner's pins (the port stamps `format: 1`). */
export const AgentPinsDocumentSchema = z.strictObject({ pins: z.array(AgentPinSchema) });
export type AgentPinsDocument = z.infer<typeof AgentPinsDocumentSchema>;
