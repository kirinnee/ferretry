/**
 * When a ferret that hit a limit is moved to another login (Warden's rule), the two triggers that are Usage's
 * facts: the login's provider says it is out of window (`rate_limited`), or its login passes its hard spend budget
 * (`budget_exceeded`, docs/budgets.md). The words are Usage's, so the Warden form and the Budgets tab say one thing.
 */
export const MOVE_TRIGGERS = [
  { id: 'rate_limited', label: 'It hits a usage limit' },
  { id: 'budget_exceeded', label: 'Its login passes its hard spend budget' },
] as const;
