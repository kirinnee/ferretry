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

/**
 * `GET /v1/usage/budgets` as a FERRET reads it: for each budgeted login its own lineage runs on, whether the login is
 * paused and nothing else. A spent amount, an unpriced count or a threshold level is a figure derived from every ferret on
 * the login, so a ferret never sees one; the owner and a person read `BudgetsView`.
 */
export const FerretBudgetsViewSchema = z.strictObject({
  budgets: z.array(z.strictObject({ login: LoginIdSchema, paused: z.boolean() })).readonly(),
});
export type FerretBudgetsView = z.infer<typeof FerretBudgetsViewSchema>;
