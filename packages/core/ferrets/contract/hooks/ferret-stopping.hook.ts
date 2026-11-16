import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretIdSchema } from '../ids.ts';

/** What `ferret.stopping` says: a stop of this ferret is being attempted. */
export const FerretStoppingPayloadSchema = z.strictObject({ ferret: FerretIdSchema });
export type FerretStoppingPayload = z.infer<typeof FerretStoppingPayloadSchema>;

/**
 * A stop of this ferret is being attempted: said BEFORE anything that can fail (a missing harness or runner, a harness
 * stop that throws), so it is heard whether or not the stop then succeeds. Conversation zeroes the ferret's decrypted
 * attachments on it (today's `releasingAttachmentsOnStop`, a `finally` around the stop): a half-stopped ferret holding
 * a decrypted document is the case worth failing closed for. `ferret.changed` still follows a stop that succeeds.
 */
export const FerretStopping = defineHook('ferret.stopping', { mode: 'observe', payload: FerretStoppingPayloadSchema });
