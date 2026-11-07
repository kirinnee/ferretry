import { defineEvent, defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { BoardChangedSchema, CardActorSchema, CardIdSchema, LaneIdSchema } from './wire.ts';

/** Takers say yes or no to a card moving lanes (decide, 200 ms). The first no wins with its reason. Taken by none yet. */
export const CardMoving = defineHook('card.moving', {
  mode: 'decide',
  input: z.strictObject({ card: CardIdSchema, from: LaneIdSchema, to: LaneIdSchema, by: CardActorSchema }),
});

/** Published after the write landed (§7.4); the truth is the owner's state, read through `BoardApi`. */
export const CardMoved = defineEvent(
  'board.card-moved',
  z.strictObject({ card: CardIdSchema, from: LaneIdSchema, to: LaneIdSchema }),
);
export const BoardChanged = defineEvent('board.changed', BoardChangedSchema);
