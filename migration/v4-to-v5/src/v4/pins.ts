/**
 * v4 (4.291.5) pin documents, as this tool reads them. LOCAL copies on purpose (the product has no v4 reader):
 *
 * - `state/sessions/<sid>/pins.json`: `PinSnapshotSchema`, `packages/protocol/src/lib/pins.ts` at v4.291.5.
 * - `state/agent-pins.json`: `AgentPinFileSchema`, `packages/daemon/src/lib/agent-pins/types.ts` at v4.291.5.
 *
 * The pin shape itself is unchanged in v5 (`packages/core/ferrets/daemon/lib/protocol/pins.ts` and
 * `daemon/lib/agent-pins/types.ts` differ only in imports), so a pin this accepts is one v5 accepts.
 */
import { z } from 'zod';

const Instant = z.iso.datetime({ offset: true });
const PositiveInteger = z.number().int().positive();

export const MAX_PINS_PER_SESSION = 20;
export const MAX_AGENT_PINS = 50;

const Provenance = z.discriminatedUnion('by', [
  z.object({ by: z.literal('human'), createdBy: z.null(), createdByName: z.null() }),
  z.object({ by: z.literal('agent'), createdBy: z.string().min(1), createdByName: z.string().nullable() }),
]);

const Identity = { id: z.uuid(), at: PositiveInteger };

const MessagePin = z.intersection(
  z.object({
    ...Identity,
    kind: z.literal('message'),
    blockId: z.string().min(1),
    blockKind: z.enum(['user', 'assistant', 'thinking', 'tools', 'system', 'notice']),
    preview: z
      .string()
      .max(200)
      .regex(/^[^\r\n]*$/u),
    ts: Instant.optional(),
  }),
  Provenance,
);

const NotePin = z.intersection(
  z.object({
    ...Identity,
    kind: z.literal('note'),
    text: z.string().min(1).max(500),
    source: z.object({ blockId: z.string().min(1) }).optional(),
  }),
  Provenance,
);

export const V4Pin = z.union([MessagePin, NotePin]);
export type V4Pin = z.infer<typeof V4Pin>;

/** One session's pins: `{v: 1, sessionId, pins, updatedAt}`. */
export const V4PinSnapshot = z
  .object({
    v: z.literal(1),
    sessionId: z.string().min(1),
    pins: z.array(V4Pin).max(MAX_PINS_PER_SESSION),
    updatedAt: Instant,
  })
  .refine(value => new Set(value.pins.map(pin => pin.id)).size === value.pins.length)
  .refine(value => {
    const blocks = value.pins.filter(pin => pin.kind === 'message').map(pin => pin.blockId);
    return new Set(blocks).size === blocks.length;
  });

export const V4AgentPin = z.strictObject({ sessionId: z.string().min(1), pinnedAt: Instant });
export type V4AgentPin = z.infer<typeof V4AgentPin>;

/** The owner's pinned ferrets: `{version: 1, pins: [{sessionId, pinnedAt}]}`. */
export const V4AgentPinFile = z.strictObject({ version: z.literal(1), pins: z.array(V4AgentPin) });
