import { describe, expect, it } from 'bun:test';
import { type AgendaItem, LOGIN_RECIPE_MAX_LENGTH } from '@ferretry/protocol';
import { list, PROPOSAL, SI_GITHUB, SI_WORK } from '../support/accounts-fixtures.ts';
import {
  changeWords,
  decisionFailureWords,
  doneWords,
  findRecipeProposal,
  placeName,
  RECIPE_STALE_WORDS,
  recipeChange,
  recipeEditProblem,
} from '../../src/lib/recipe-proposal.ts';

const ref = { signIn: SI_GITHUB, id: PROPOSAL } satisfies NonNullable<AgendaItem['recipeProposal']>;

describe('recipeChange', () => {
  it('numbers the steps that remain and marks what was added and removed', () => {
    const change = recipeChange(
      ['Open the login page', 'Fill the username', 'Press Enter'].join('\n'),
      ['Open the login page', 'Fill the username', 'Press Enter, then wait', 'Ask for the code'].join('\n'),
    );

    expect(change.steps).toEqual([
      { kind: 'kept', text: 'Open the login page', number: 1 },
      { kind: 'kept', text: 'Fill the username', number: 2 },
      { kind: 'removed', text: 'Press Enter' },
      { kind: 'added', text: 'Press Enter, then wait', number: 3 },
      { kind: 'added', text: 'Ask for the code', number: 4 },
    ]);
    expect(change.added).toBe(2);
    expect(change.removed).toBe(1);
  });

  it('skips blank lines and drops a list marker the card numbers itself', () => {
    const change = recipeChange(undefined, ['# Sign in', '', '1. Open the page', '- Press Enter'].join('\n'));

    expect(change.steps.map(step => step.text)).toEqual(['# Sign in', 'Open the page', 'Press Enter']);
    expect(change.steps.map(step => step.number)).toEqual([1, 2, 3]);
    expect(change.added).toBe(3);
    expect(change.removed).toBe(0);
  });
});

describe('changeWords', () => {
  it('says which version the proposal replaces and what changed', () => {
    expect(changeWords(3, { added: 2, removed: 1 })).toBe('v3 → proposed · 2 added, 1 removed');
    expect(changeWords(3, { added: 2, removed: 0 })).toBe('v3 → proposed · 2 added');
    expect(changeWords(3, { added: 0, removed: 0 })).toBe('v3 → proposed · no change');
  });

  it('says there was no recipe when the sign-in has none', () => {
    expect(changeWords(undefined, { added: 4, removed: 0 })).toBe('No recipe yet → proposed · 4 added');
  });
});

describe('findRecipeProposal', () => {
  it('finds the sign-in, its proposal and the place it is for', () => {
    const found = findRecipeProposal(list(), ref);

    expect(found?.proposal.id).toBe(PROPOSAL);
    expect(found?.signIn.id).toBe(SI_GITHUB);
    expect(found?.place).toBe('github.com');
  });

  it('finds nothing for a proposal the daemon no longer holds, or a sign-in that is gone', () => {
    expect(findRecipeProposal(list(), { ...ref, id: 'rp_ffffffffffffffff' })).toBeUndefined();
    expect(findRecipeProposal(list(), { signIn: 'si_00000000000000ff', id: PROPOSAL })).toBeUndefined();
    expect(findRecipeProposal(list(), { signIn: SI_WORK, id: PROPOSAL })).toBeUndefined();
  });
});

describe('placeName', () => {
  it('names a site by its login domains, falling back to what it matches, and a terminal by its key', () => {
    expect(placeName({ kind: 'site', domains: ['github.com', 'gist.github.com'], match: [] })).toBe(
      'github.com, gist.github.com',
    );
    expect(placeName({ kind: 'site', domains: [], match: ['app.vercel.com'] })).toBe('app.vercel.com');
    expect(placeName({ kind: 'terminal', tool: 'sudo', host: 'kirin-box' })).toBe('sudo@kirin-box');
  });
});

describe('doneWords', () => {
  it('says what was decided and for where', () => {
    expect(doneWords('approve', 'github.com')).toBe('Recipe for github.com approved.');
    expect(doneWords('decline', 'github.com')).toBe('Declined.');
  });
});

describe('decisionFailureWords', () => {
  it('says the recipe changed on a stale proposal, whatever the daemon wrote', () => {
    const stale = Object.assign(new Error('refused'), { status: 409, code: 'stale_proposal' });

    expect(decisionFailureWords(stale)).toBe(RECIPE_STALE_WORDS);
  });

  it('keeps any other refusal in the daemon’s own words', () => {
    expect(decisionFailureWords(Object.assign(new Error('The secret store is damaged.'), { status: 500 }))).toBe(
      'The secret store is damaged.',
    );
    expect(decisionFailureWords('boom')).toBe('boom');
  });
});

describe('recipeEditProblem', () => {
  it('refuses an empty or too long recipe before it is sent', () => {
    expect(recipeEditProblem('  \n ')).toBe('Write the steps first.');
    expect(recipeEditProblem('x'.repeat(LOGIN_RECIPE_MAX_LENGTH + 1))).toContain('too long');
    expect(recipeEditProblem('Open the page')).toBeUndefined();
  });
});
