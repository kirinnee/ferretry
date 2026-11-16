import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { OpeningAttachmentsSource } from '../kinds.ts';

/** The one key `opening.attachments` is provided under: a start's attachments have exactly one owner. */
export const OPENING_ATTACHMENTS_KEY = 'opening';

/**
 * The owner of attachments plans the files a start was given (`fy start -f`). On the security path: its answer decides
 * the bytes written into the agent-readable `attachments/` folder and the words of turn-001, so ONE named plugin provides
 * it and a second taker refuses the build. With no provider a start that carries attachments is refused rather than
 * started without them.
 */
export const OpeningAttachments = defineHook('opening.attachments', {
  mode: 'provide',
  key: z.literal(OPENING_ATTACHMENTS_KEY),
  value: z.custom<OpeningAttachmentsSource>(),
  takers: ['conversation'],
});
