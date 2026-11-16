import { describe, expect, test } from 'bun:test';
import { BudgetEditError, editedBudget, withLoginBudget } from '../../../cli/lib/budget.ts';

describe('editedBudget', () => {
  test('--clear removes the budget', () => {
    expect(editedBudget({ daily: { hard: 10 } }, { clear: true })).toBeUndefined();
  });

  test('edits only the levels named, keeping the others', () => {
    expect(editedBudget({ daily: { trigger: 4, hard: 6 } }, { dailyHard: 8, weeklyTrigger: 30 })).toEqual({
      daily: { trigger: 4, hard: 8 },
      weekly: { trigger: 30 },
    });
  });

  test('turning every level off leaves no budget at all', () => {
    expect(
      editedBudget({ daily: { trigger: 4 }, weekly: { hard: 9 } }, { dailyTrigger: 'off', weeklyHard: 'off' }),
    ).toBeUndefined();
    expect(editedBudget(undefined, {})).toBeUndefined();
  });
});

describe('withLoginBudget', () => {
  test('refuses a file that does not parse, saying to fix it first', () => {
    expect(() => withLoginBudget('a: [unclosed\n', 'claude-a', { daily: { hard: 5 } })).toThrow(BudgetEditError);
    expect(() => withLoginBudget('a: [unclosed\n', 'claude-a', { daily: { hard: 5 } })).toThrow(
      'usage.yaml does not parse; fix it first.',
    );
  });

  test('writes one login’s entry and keeps the others, and removes the key when none is left', () => {
    const written = withLoginBudget('budgets:\n  other:\n    daily:\n      hard: 3\n', 'claude-a', {
      daily: { hard: 5 },
    });
    expect(written).toContain('other:');
    expect(written).toContain('claude-a:');
    expect(withLoginBudget(written, 'claude-a', undefined)).toContain('other:');
    expect(withLoginBudget('budgets:\n  claude-a:\n    daily:\n      hard: 5\n', 'claude-a', undefined)).not.toContain(
      'budgets',
    );
  });
});
