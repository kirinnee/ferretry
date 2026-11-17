import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { IsoInstantSchema } from '../records.ts';

export const RestartsFile = defineState({ name: 'restarts', path: 'restarts.json', store: 'json', format: 1 });

/**
 * `self-restart.json` (F-0209): the self-restart cooldown stamp, kept so it outlives the restart it records. A file that
 * is there but cannot be read is NOT "no stamp" (the reader fails): that is the shape a restart loop leaves.
 */
export const SelfRestartStampSchema = z.strictObject({
  format: z.literal(1),
  at: IsoInstantSchema,
  sessions: z.array(z.string().min(1)),
});
export const SelfRestartFile = defineState({
  name: 'self-restart',
  path: 'self-restart.json',
  store: 'json',
  format: 1,
  schema: SelfRestartStampSchema,
});
