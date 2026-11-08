import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { SurfaceKeySchema } from '../../../contract/index.ts';

/**
 * The app's copy of two wire shapes it reads from routes other halves serve (today's `protocol/src/lib`): the
 * terminals a secret was just typed into, kept from view until `until` (Vault's holds list), and which part of a
 * ferret's pane a snapshot reads (Ferrets' snapshot route). Neither is in a frozen contract yet.
 */
const InputQuarantineSchema = z.strictObject({ key: SurfaceKeySchema, until: InstantSchema });
export type InputQuarantine = z.infer<typeof InputQuarantineSchema>;
export const InputQuarantineListSchema = z.strictObject({ quarantines: z.array(InputQuarantineSchema) });
export type InputQuarantineList = z.infer<typeof InputQuarantineListSchema>;

const SnapshotScopeSchema = z.enum(['history', 'screen']);
export type SnapshotScope = z.infer<typeof SnapshotScopeSchema>;
