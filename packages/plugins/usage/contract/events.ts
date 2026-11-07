import { defineEvent } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { LoginIdSchema } from './ids.ts';

/** Wake-ups, published after the write landed. The truth is `UsageApi`; none is relied on. */
export const LoginPaused = defineEvent(
  'usage.login-paused',
  z.strictObject({ login: LoginIdSchema, level: z.enum(['over_trigger', 'over_hard']), period: z.enum(['daily', 'weekly']) }),
);
export const LoginResumed = defineEvent('usage.login-resumed', z.strictObject({ login: LoginIdSchema }));
/** The insights index took a finished ferret's row, or was rebuilt. */
export const InsightsChanged = defineEvent('usage.insights-changed', z.strictObject({}));
