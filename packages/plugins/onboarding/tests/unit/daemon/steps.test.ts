import { describe, expect, test } from 'bun:test';
import type { OnboardingEntry, PluginId } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import type { Progress } from '../../../contract/index.ts';
import {
  answeredKeys,
  EMPTY_PROGRESS,
  findEntry,
  isComplete,
  joinProgress,
  orderedSteps,
  splitStepKey,
  stepKey,
  viewOf,
  withAnswer,
} from '../../../daemon/lib/steps.ts';

const entry = (plugin: string, id: string, order: number, title = id): OnboardingEntry => ({
  plugin: plugin as PluginId,
  id,
  title,
  order,
});
const AT = '2026-11-06T09:00:00.000Z' as Instant;

const ENTRIES = [
  entry('shells', 'nix', 80, 'Shells'),
  entry('claude-code', 'harness', 20, 'Claude Code'),
  entry('logins', 'login', 30, 'Sign in'),
  entry('codex', 'harness', 21, 'Codex'),
];

describe('first-run step order', () => {
  test('steps come back by order, whatever order the snapshot held them in', () => {
    expect(orderedSteps(ENTRIES).map(step => stepKey(step.plugin, step.id))).toEqual([
      'claude-code:harness',
      'codex:harness',
      'logins:login',
      'shells:nix',
    ]);
  });

  test('two steps with the same order are ordered by plugin then id, the same on every read', () => {
    const tied = [entry('b', 'x', 5), entry('a', 'z', 5), entry('a', 'y', 5)];
    expect(orderedSteps(tied).map(step => stepKey(step.plugin, step.id))).toEqual(['a:y', 'a:z', 'b:x']);
    expect(orderedSteps([...tied].reverse())).toEqual(orderedSteps(tied));
  });

  test('ordering never mutates what the snapshot holds', () => {
    const frozen = Object.freeze([...ENTRIES]);
    expect(() => orderedSteps(frozen)).not.toThrow();
    expect(String(frozen[0]?.plugin)).toBe('shells');
  });
});

describe('joining steps with progress', () => {
  test('a step nobody recorded is pending with no time', () => {
    const [first] = joinProgress(ENTRIES, undefined);
    expect(first).toEqual({ plugin: 'claude-code', id: 'harness', title: 'Claude Code', order: 20, state: 'pending' });
    expect('at' in (first ?? {})).toBe(false);
  });

  test('a recorded step carries its state and when', () => {
    const progress: Progress = { format: 1, steps: { 'logins:login': { state: 'found', at: AT } } };
    const login = joinProgress(ENTRIES, progress).find(step => step.id === 'login');
    expect(login?.state).toBe('found');
    expect(login?.at).toBe(AT);
  });

  test('a record for a plugin that is off is ignored, not shown and not lost', () => {
    const progress: Progress = { format: 1, steps: { 'gone:step': { state: 'done', at: AT } } };
    expect(joinProgress(ENTRIES, progress).map(step => step.plugin)).not.toContain('gone');
    expect(Object.keys(progress.steps)).toEqual(['gone:step']);
  });

  test('a snapshot with no steps is an empty, complete view', () => {
    expect(viewOf([], undefined)).toEqual({ steps: [], complete: true });
  });
});

describe('completeness', () => {
  test('complete means none pending: found, done, later and skipped all count', () => {
    const progress: Progress = {
      format: 1,
      steps: {
        'claude-code:harness': { state: 'found', at: AT },
        'codex:harness': { state: 'later', at: AT },
        'logins:login': { state: 'done', at: AT },
        'shells:nix': { state: 'skipped', at: AT },
      },
    };
    expect(viewOf(ENTRIES, progress).complete).toBe(true);
  });

  test('one pending step keeps the run incomplete', () => {
    const progress: Progress = {
      format: 1,
      steps: {
        'claude-code:harness': { state: 'found', at: AT },
        'codex:harness': { state: 'found', at: AT },
        'logins:login': { state: 'found', at: AT },
      },
    };
    const view = viewOf(ENTRIES, progress);
    expect(view.complete).toBe(false);
    expect(isComplete(view.steps)).toBe(false);
  });
});

describe('recording an answer', () => {
  test('an answer is added with its time and leaves the other steps alone', () => {
    const before: Progress = { format: 1, steps: { 'codex:harness': { state: 'later', at: AT } } };
    const later = '2026-11-06T10:00:00.000Z' as Instant;
    const after = withAnswer(before, 'logins', 'login', { state: 'done' }, later);
    expect(after.steps['logins:login']).toEqual({ state: 'done', at: later });
    expect(after.steps['codex:harness']).toEqual({ state: 'later', at: AT });
    expect(before.steps['logins:login']).toBeUndefined();
  });

  test('answering again replaces the earlier answer', () => {
    const first = withAnswer(undefined, 'logins', 'login', { state: 'later' }, AT);
    const second = withAnswer(first, 'logins', 'login', { state: 'done' }, AT);
    expect(second.steps['logins:login']?.state).toBe('done');
  });

  test('n1 a found step can be recorded as the terminal’s own sign-in, and answering again drops the mark', () => {
    const found = withAnswer(undefined, 'logins', 'login', { state: 'found', linked: true }, AT);
    expect(found.steps['logins:login']).toEqual({ state: 'found', at: AT, linked: true });
    const view = joinProgress([entry('logins', 'login', 30, 'Sign in')], found);
    expect(view[0]?.linked).toBe(true);
    const again = withAnswer(found, 'logins', 'login', { state: 'done' }, AT);
    expect(again.steps['logins:login']).toEqual({ state: 'done', at: AT });
    expect('linked' in (joinProgress([entry('logins', 'login', 30)], again)[0] ?? {})).toBe(false);
  });

  test('the empty progress is format 1 with no steps', () => {
    expect(EMPTY_PROGRESS).toEqual({ format: 1, steps: {} });
  });

  test('answeredKeys names every recorded step and splitStepKey reads one back', () => {
    const progress: Progress = {
      format: 1,
      steps: { 'logins:login': { state: 'done', at: AT }, 'shells:nix': { state: 'skipped', at: AT } },
    };
    expect(answeredKeys(progress)).toEqual(['logins:login', 'shells:nix']);
    expect(splitStepKey('logins:login')).toEqual({ plugin: 'logins', step: 'login' });
    expect(splitStepKey('nonsense')).toBeUndefined();
    expect(splitStepKey(':x')).toBeUndefined();
  });

  test('findEntry finds a step by plugin and id, and nothing else', () => {
    expect(findEntry(ENTRIES, 'codex', 'harness')?.title).toBe('Codex');
    expect(findEntry(ENTRIES, 'codex', 'nix')).toBeUndefined();
  });
});
