/** "Always use for <project>" as a decision (`app/lib/always-use.ts`): when it is offered, and what a tap would write. */

import { describe, expect, it } from 'bun:test';
import { alwaysUseFailureWords, alwaysUseFor, alwaysUseSavedWords } from '../../../app/lib/always-use.ts';
import { PutAccountDefaultRequestSchema } from '../../../contract/routes/index.ts';
import { list } from '../../support/app/accounts-fixtures.ts';
import { settledSlot } from '../../support/app/input-card-fixtures.ts';

const slot = (over: Record<string, unknown> = {}) => settledSlot(over) as never;
const accounts = list();

describe('when "Always use for <project>" is offered', () => {
  it('is offered after a tap on a matched account, with the exact body the owner route takes', () => {
    const always = alwaysUseFor(slot(), accounts);
    expect(always).toEqual({
      project: 'demo-project',
      label: 'GitHub',
      key: 'github.com',
      body: { scope: 'projects', within: '0b6f3c1e-2d4a-4c8b-9e1f-7a5d3c2b1a09', key: 'github.com', account: 'GITHUB' },
    });
    // The body is one the route's own schema accepts.
    expect(PutAccountDefaultRequestSchema.safeParse(always?.body).success).toBe(true);
    expect(alwaysUseSavedWords(always as never)).toBe('GitHub is now the default for demo-project at github.com.');
  });

  it('is not offered when the daemon resolved no project (Unfiled)', () => {
    const { project: _project, ...bare } = settledSlot();
    expect(alwaysUseFor(bare as never, accounts)).toBeUndefined();
  });

  it('is not offered when the card matched no place, or a place that is not a key', () => {
    const { place: _place, ...bare } = settledSlot();
    expect(alwaysUseFor(bare as never, accounts)).toBeUndefined();
    expect(alwaysUseFor(slot({ place: 'Not A Key!' }), accounts)).toBeUndefined();
  });

  it('is not offered when the tap used no sign-in', () => {
    const { signIn: _signIn, ...bare } = settledSlot();
    expect(alwaysUseFor(bare as never, accounts)).toBeUndefined();
  });

  it('is not offered when the tapped account already is the project’s default', () => {
    expect(alwaysUseFor(slot({ projectDefault: true }), accounts)).toBeUndefined();
  });

  it('is not offered for a sign-in of another account than the one tapped, or one this machine no longer has', () => {
    expect(alwaysUseFor(slot({ entry: 'GITHUB_WORK' }), accounts)).toBeUndefined();
    expect(alwaysUseFor(slot({ signIn: 'si_00000000000000ff' }), accounts)).toBeUndefined();
    expect(alwaysUseFor(slot({ entry: 'NOT_AN_ACCOUNT' }), accounts)).toBeUndefined();
  });

  it('is not offered for a place the daemon does not match to that sign-in (never a default for an unmatched account)', () => {
    expect(alwaysUseFor(slot({ place: 'evil.example' }), accounts)).toBeUndefined();
    expect(alwaysUseFor(slot({ place: 'vercel.com' }), accounts)).toBeUndefined();
  });
});

describe('what a refused write says', () => {
  it('says a grant refusal in the grant’s words, and anything else in fixed words that echo nothing', () => {
    expect(alwaysUseFailureWords({ status: 403, code: 'grant_device_withheld', message: 'x' })).toBe(
      'This device’s access to this machine does not allow that.',
    );
    const other = alwaysUseFailureWords(Object.assign(new Error('boom: GITHUB secret-xyz'), { status: 500 }));
    expect(other).toBe('Could not save that default. Nothing changed.');
    expect(other).not.toContain('secret-xyz');
  });
});
