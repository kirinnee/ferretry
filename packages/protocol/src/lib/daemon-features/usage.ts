/** Login spend budgets (`login.budget.*`). One fragment of `DAEMON_FEATURES`; `index.ts` spreads them all. */
export const USAGE_FEATURES = {
  /**
   * Login spend budgets (docs/budgets.md): `budget` in a login's file and `timeZone` in machine.yaml, metered and
   * enforced. A daemon without this name refuses both keys as unknown, so the app offers the budget editor only
   * where the machine reports it and otherwise says the machine needs an update.
   */
  loginBudget: 'login.budget.1',
} as const;
