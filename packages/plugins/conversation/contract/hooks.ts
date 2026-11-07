import { defineHook } from '@ferretry/kernel/contract';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';

/** Takers change a message on its way to a ferret (§3.5). Taken by none yet. */
export const MessageBeforeSend = defineHook('message.before-send', {
  mode: 'transform',
  value: z.strictObject({ ferret: FerretIdSchema, text: z.string() }),
});

/** One round of a ferret working ended. Taken by Warden, Usage and Lessons. */
export const TurnEnded = defineHook('turn.ended', {
  mode: 'observe',
  payload: z.strictObject({
    ferret: FerretIdSchema,
    turn: z.string().min(1),
    outcome: z.enum(['completed', 'interrupted', 'failed']),
    endedAt: InstantSchema,
  }),
});
