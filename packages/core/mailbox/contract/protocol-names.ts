/**
 * The names the ported send and queue code was written against, over the Mailbox's own wire. Where the contract renamed a
 * thing to the words (§1), the old name is still exported here as an alias; nothing here is a second definition.
 */
import type { z } from 'zod';
import { REQUEST_ID_HEADER } from './codes.ts';
import { type HandoffAttachment, HandoffNameSchema, type HandoffDocument } from './turn-handoff.ts';
import {
  ComposerRequestSchema,
  type ComposerResultSchema,
  InterruptRequestSchema,
  type SendCancelEffectSchema,
  type SendDispositionSchema,
} from './wire-send.ts';

export const ComposerDraftRequestSchema = ComposerRequestSchema;
export type ComposerDraftRequest = z.infer<typeof ComposerRequestSchema>;
export type ComposerDraftResult = z.infer<typeof ComposerResultSchema>;
export const InterruptSessionRequestSchema = InterruptRequestSchema;
export type SendCancelEffect = z.infer<typeof SendCancelEffectSchema>;
export type SendDisposition = z.infer<typeof SendDispositionSchema>;
export type SendQueueProof = 'transcript' | 'pane';
export const FY_REQUEST_ID_HEADER = REQUEST_ID_HEADER;
export const SessionHandoffNameSchema = HandoffNameSchema;
export type SessionHandoff = HandoffDocument;
export type SessionHandoffAttachment = HandoffAttachment;
