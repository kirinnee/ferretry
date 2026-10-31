/** Fake recipe, observed facts and one proposal for a saved login. No real account, host or value. */
import type { LoginEntryList, LoginEntrySummary } from '@ferretry/protocol';
import { login, logins } from './input-fixtures.ts';

const SEEN = '2026-10-28T09:00:00.000Z';
const flag = (value: boolean, count: number) => ({ value, observedAt: SEEN, count });

export const BASE_RECIPE = ['Open app.example.test', 'Press Continue with Google', 'Wait for the phone approval'].join(
  '\n',
);
export const NEXT_RECIPE = [
  'Open app.example.test',
  'Press Continue with Google',
  'Pick the work account',
  'Wait for the phone approval',
].join('\n');

export const PROPOSAL_ID = 'rp_0123456789abcdef';

export const withRecipe = (overrides: Partial<LoginEntrySummary> = {}): LoginEntrySummary =>
  login({
    id: 'EXAMPLE_APP',
    label: 'Example app',
    match: ['app.example.test'],
    username: undefined,
    recipe: BASE_RECIPE,
    observed: [
      {
        at: 'accounts.example.test',
        surface: 'page',
        identity: '0123456789abcdef',
        since: SEEN,
        masked: flag(true, 3),
        noEchoAfterSubmit: flag(true, 3),
        navigatedAway: flag(true, 3),
        secondFactor: { value: 'push', observedAt: SEEN, count: 3 },
      },
      {
        at: 'sudo@kirin-box',
        surface: 'terminal',
        identity: 'fedcba9876543210',
        since: SEEN,
        masked: flag(true, 2),
      },
    ],
    proposals: [
      {
        id: PROPOSAL_ID,
        recipe: NEXT_RECIPE,
        base: BASE_RECIPE,
        why: 'The sign-in asked which account to use.',
        sessionId: 'session-1',
        proposedAt: '2026-10-30T08:30:00.000Z',
      },
    ],
    ...overrides,
  });

export const recipeLogins = (overrides: Partial<LoginEntrySummary> = {}): LoginEntryList =>
  logins({ entries: [withRecipe(overrides)] });
