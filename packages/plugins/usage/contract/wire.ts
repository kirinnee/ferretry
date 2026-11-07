import { LoginBudgetSchema } from '@ferretry/plugin-logins/contract';
import { z } from 'zod';
import { LoginIdSchema } from './ids.ts';
import { LoginPauseSchema } from './pause.ts';

/** One login's standing against its budget, with the pause it is under (if any). */
export const BudgetStandingSchema = z.strictObject({
  login: LoginIdSchema,
  budget: LoginBudgetSchema,
  pause: LoginPauseSchema.optional(),
});
export type BudgetStanding = z.infer<typeof BudgetStandingSchema>;

/** `GET /v1/usage/budgets`: every budgeted login. Empty until the meter has read once (`measured: false` on each). */
export const BudgetsViewSchema = z.strictObject({ budgets: z.array(BudgetStandingSchema).readonly() });
export type BudgetsView = z.infer<typeof BudgetsViewSchema>;
