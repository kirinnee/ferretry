import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { RunnerKeySchema } from '../ids.ts';
import type { Runner } from '../kinds.ts';

export const Runners = defineHook('runners', {
  mode: 'provide',
  key: RunnerKeySchema,
  value: z.custom<Runner>(),
  takers: ['terminals'],
});
