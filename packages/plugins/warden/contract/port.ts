import { definePort, defineEvent } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { FerretId } from './core.ts';
import { FerretIdSchema } from './core.ts';
import type {
  WardenBlessingView,
  WardenConfig,
  WardenFile,
  WardenFlag,
  WardenInvestigateRequest,
  WardenLeaveRequest,
  WardenRunView,
} from './wire.ts';
import { WardenAnomalyKindSchema } from './wire.ts';

/** What the app and other plugins read from Warden. Remedies are the warden's own acts; nothing here commands one. */
export interface WardenApi {
  flags(): Promise<readonly WardenFlag[]>;
  config(): Promise<WardenConfig>;
  configure(patch: WardenFile): Promise<WardenConfig>;
  /** One sweep. `spawn` also starts a warden for what it found. */
  sweep(options: { readonly spawn: boolean }): Promise<WardenRunView>;
  /** The owner asks for a ferret to be looked at now. */
  investigate(
    request: WardenInvestigateRequest,
  ): Promise<{ readonly state: 'queued' | 'running'; readonly message: string }>;
  /** The owner leaves a ferret alone for longer. */
  leave(request: WardenLeaveRequest): Promise<WardenBlessingView>;
  blessed(ferret: FerretId): Promise<WardenBlessingView | undefined>;
}
export const WardenPort = definePort<WardenApi>('warden');

/** Published after a sweep wrote its state; the truth is `WardenApi.flags()`. */
export const WardenFlagged = defineEvent(
  'warden.flagged',
  z.strictObject({ ferret: FerretIdSchema, kind: WardenAnomalyKindSchema }),
);
export const WardenActed = defineEvent(
  'warden.acted',
  z.strictObject({ ferret: FerretIdSchema, action: z.string().min(1), outcome: z.enum(['done', 'held', 'failed']) }),
);
