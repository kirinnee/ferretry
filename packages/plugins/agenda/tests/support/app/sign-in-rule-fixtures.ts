/**
 * A ferret's rule suggestion as Accounts' owner list answers it (`GET /v1/sign-in-rules/suggestions`), for the suites
 * that read that list. The shape is today's `SignInRuleSuggestionView`; the Agenda reads only its id.
 */

const SUGGESTION_ID = 'srg_0000000000000001';

export interface SuggestionFixture {
  readonly id: string;
  readonly surface: 'page';
  readonly host: string;
  readonly why: string;
  readonly agenda: string;
  readonly raisedAt: string;
  readonly expiresAt: string;
}

export const suggestion = (extra: Partial<SuggestionFixture> = {}): SuggestionFixture => ({
  id: SUGGESTION_ID,
  surface: 'page',
  host: 'github.com',
  why: 'I sign in here on every task.',
  agenda: 'A12',
  raisedAt: '2026-11-01T09:50:00.000Z',
  expiresAt: '2026-11-02T09:50:00.000Z',
  ...extra,
});
