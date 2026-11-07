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

/**
 * A login passed its hard limit: its ferrets were stopped (or none was running) and the owner is to be told once per
 * period. `ref` is stable per login and period start, so whoever lists what needs the owner (Agenda) never lists it
 * twice. Usage raises nothing on anyone's list itself, and moves no ferret to another login.
 */
export const BudgetReached = defineEvent(
  'usage.budget-reached',
  z.strictObject({
    ref: z.string().min(1),
    login: LoginIdSchema,
    period: z.enum(['daily', 'weekly']),
    ferret: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    body: z.string().min(1),
  }),
);
