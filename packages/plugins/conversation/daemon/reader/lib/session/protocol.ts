/**
 * The few wire shapes the transcript reading code is written against, copied from today's protocol package
 * (`session-transfer-edge.ts`, `session.ts`): a message's durable coordinate, and the evidence of which file is a
 * ferret's transcript. The contract carries the coordinate as one opaque string on the wire (`point`); these are what
 * the reader folds it from and to ({@link formatPoint}, {@link parsePoint}).
 */
import { z } from 'zod';

const NonNegativeIntegerSchema = z.number().int().nonnegative();

/** An ISO-8601 instant with an explicit timezone, kept exactly as written: the message token MACs these bytes, so it is never re-spelled. */
const InstantSchema = z.iso.datetime({ offset: true });

/** One durable message inside a provenance-bound harness transcript. */
export const ConversationMessagePointSchema = z.strictObject({
  v: z.literal(1),
  byteOffset: NonNegativeIntegerSchema,
  blockIndex: NonNegativeIntegerSchema.optional(),
});
export type ConversationMessagePoint = z.infer<typeof ConversationMessagePointSchema>;

/** A fork cut must address one block, not merely a record offset. */
export const ExactConversationMessagePointSchema = ConversationMessagePointSchema.extend({
  blockIndex: NonNegativeIntegerSchema,
});
export type ExactConversationMessagePoint = z.infer<typeof ExactConversationMessagePointSchema>;

/** The wire spelling of a point: `<byteOffset>.<blockIndex>`, one opaque string to every client. */
export const formatPoint = (point: ExactConversationMessagePoint): string =>
  `${String(point.byteOffset)}.${String(point.blockIndex)}`;

const POINT = /^(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,8})$/u;

/** The point a wire string spells, or `undefined`. Total. */
export const parsePoint = (text: string): ExactConversationMessagePoint | undefined => {
  const match = POINT.exec(text);
  if (match === null) return undefined;
  return { v: 1, byteOffset: Number(match[1]), blockIndex: Number(match[2]) };
};

/** How this ferret's harness transcript was IDENTIFIED. */
export const TranscriptIdentitySchema = z.enum(['minted', 'correlated', 'adopted', 'undiscovered']);
export type TranscriptIdentity = z.infer<typeof TranscriptIdentitySchema>;

/** Where this ferret's transcript lives, recorded as evidence captured at launch (a provenance record, not a cache). */
export const TranscriptProvenanceSchema = z
  .object({
    v: z.literal(1),
    home: z.string().min(1),
    harnessSessionId: z.string().min(1).optional(),
    identity: TranscriptIdentitySchema,
    baseline: z.array(z.string().min(1)).optional(),
    correlationToken: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    resolvedAt: InstantSchema.optional(),
  })
  .refine(value => (value.identity === 'undiscovered') === (value.harnessSessionId === undefined), {
    message: 'an identified transcript must name the harness session it belongs to',
    path: ['harnessSessionId'],
  })
  .refine(value => (value.identity === 'undiscovered') === (value.file === undefined), {
    message: 'an identified transcript must name its file',
    path: ['file'],
  });
export type TranscriptProvenance = z.infer<typeof TranscriptProvenanceSchema>;
