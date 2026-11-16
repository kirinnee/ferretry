import { defineState } from '@ferretry/kernel/contract';
import { JsonValueSchema } from '@ferretry/std';
import { z } from 'zod';
import { IsoInstantSchema } from '../records.ts';

/**
 * `health.jsonl` (F-0203, today's `health-events.jsonl`): the daemon's own journal of fleet-wide health events (a
 * wedged self-check, an index that would not heal, a self-restart), one stamped line each. A daemon journal, not a
 * ferret's: none of them belong to one session. Ferrets' own file, written through its state port.
 */
export const HealthEventSchema = z.strictObject({
  at: IsoInstantSchema,
  type: z.string().min(1),
  data: z.record(z.string(), JsonValueSchema),
});
export const HealthEventsFile = defineState({
  name: 'health',
  path: 'health.jsonl',
  store: 'jsonl',
  format: 1,
  schema: HealthEventSchema,
});
