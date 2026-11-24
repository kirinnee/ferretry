import { THIRD_HARNESS_KEY } from '@ferretry/core-ferrets/contract/testing';
import { describe, expect, test } from 'bun:test';
import { harnessOfSubject } from '../../../app/features/add-login-panel.tsx';
import {
  HARNESSES,
  loginGroups,
  loginScopeWords,
  scopeOfHarnesses,
  suggestLoginId,
  terminalBadge,
} from '../../../app/lib/logins-view.ts';
import { lockedSummary } from '../../../app/lib/locked-summary.ts';
import { login, loginList } from '../cli/fakes.ts';

/** RUNTIMES PLAN U4b (Logins): the app never reads a harness it has no row for as Claude Code. */
describe('the app with a harness Logins has no behaviour for', () => {
  test('refuses to name its terminal command or to suggest a login id from it', () => {
    expect(() => terminalBadge(login({ harness: THIRD_HARNESS_KEY, sharedWithTerminal: true }))).toThrow(
      `${THIRD_HARNESS_KEY} is not supported here`,
    );
    expect(() => suggestLoginId(THIRD_HARNESS_KEY, 'work', new Set())).toThrow(
      `${THIRD_HARNESS_KEY} is not supported here`,
    );
    expect(suggestLoginId('codex', 'Work', new Set())).toBe('codex-work');
  });

  test('offers only the harnesses it has rows for, and words a scope for each', () => {
    expect(HARNESSES).toEqual(['claude-code', 'codex']);
    expect(scopeOfHarnesses(['claude-code', 'codex'])).toBe('both');
    expect(scopeOfHarnesses(['codex'])).toBe('codex');
    expect(scopeOfHarnesses([])).toBe('claude-code');
    expect(loginScopeWords('both')).toBe('Claude + Codex');
    expect(loginScopeWords('claude-code')).toBe('Claude only');
    expect(loginScopeWords(THIRD_HARNESS_KEY)).toBe(`${THIRD_HARNESS_KEY} only`);
    expect(loginGroups(loginList(login({ id: 'a' }))).map(group => group.title)).toEqual(['Claude Code']);
  });

  test('locks a panel only to a tool a subject names by its command', () => {
    expect(harnessOfSubject('harness:claude')).toBe('claude-code');
    expect(harnessOfSubject('harness:codex')).toBe('codex');
    expect(harnessOfSubject('harness:claude-code')).toBeUndefined();
    expect(harnessOfSubject('harness:gemni')).toBeUndefined();
    expect(harnessOfSubject(undefined)).toBeUndefined();
  });

  test('words a summary for one tool by dropping every other tool’s sentence', () => {
    expect(lockedSummary('Claude Code and Codex use it. Codex 0.146 or newer is needed.', 'claude-code')).toBe(
      'Claude Code use it.',
    );
  });
});
