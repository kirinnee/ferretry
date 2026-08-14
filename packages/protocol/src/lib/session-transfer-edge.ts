import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';
import { HarnessSchema } from './session-base.ts';

/** One durable message inside a provenance-bound harness transcript. */
export const ConversationMessagePointSchema = z.strictObject({
  v: z.literal(1),
  byteOffset: NonNegativeIntegerSchema,
  // Kept optional for plans written before multi-block transcript records were exported. Forks
  // refine this legacy durable shape to an exact point at their request boundary.
  blockIndex: NonNegativeIntegerSchema.optional(),
});
export type ConversationMessagePoint = z.infer<typeof ConversationMessagePointSchema>;

/** A newly-issued fork cut must address one block, not merely a legacy record offset. */
export const ExactConversationMessagePointSchema = ConversationMessagePointSchema.extend({
  blockIndex: NonNegativeIntegerSchema,
});
export type ExactConversationMessagePoint = z.infer<typeof ExactConversationMessagePointSchema>;

/** A target-only edge back to the exact source and transfer decision that created it. */
export const SessionTransferEdgeSchema = z
  .strictObject({
    v: z.literal(1),
    kind: z.enum(['handover', 'fork']),
    sourceSessionId: z.string().min(1),
    sourceIncarnation: z.string().min(1),
    sourceHarness: HarnessSchema,
    cutMessagePoint: ConversationMessagePointSchema.nullable(),
    planId: z.string().min(1),
    at: InstantSchema,
  })
  .superRefine((value, context) => {
    const shouldCarryConversation = value.kind === 'fork';
    if (shouldCarryConversation !== (value.cutMessagePoint !== null)) {
      context.addIssue({
        code: 'custom',
        message:
          value.kind === 'fork' ? 'a fork must name its exact message cut' : 'a handover has no conversation cut',
        path: ['cutMessagePoint'],
      });
    }
    if (value.kind === 'fork' && value.cutMessagePoint?.blockIndex === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'a fork must name the exact block inside its message record',
        path: ['cutMessagePoint', 'blockIndex'],
      });
    }
  });
export type SessionTransferEdge = z.infer<typeof SessionTransferEdgeSchema>;
