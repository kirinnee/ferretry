import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { HarnessKeySchema } from '../ids.ts';
import type { Harness } from '../kinds.ts';

export const Harnesses = defineHook('harnesses', {
  mode: 'provide',
  key: HarnessKeySchema,
  value: z.custom<Harness>(),
  takers: ['claude-code', 'codex'],
});
