import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { LoginKindKeySchema } from '../ids.ts';
import type { LoginKind } from '../kinds.ts';

export const Logins = defineHook('logins', {
  mode: 'provide',
  key: LoginKindKeySchema,
  value: z.custom<LoginKind>(),
  takers: ['logins'],
});
