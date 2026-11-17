import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

/**
 * The words the Board rule puts in a lead ferret's prompt (`instructions/board.md`), pinned exactly so a change shows
 * in review, and every command it names checked against the verbs this plugin declares. The runtimes wrapper says the
 * same words (its own snapshot); this file owns them.
 */
const BOARD_RULE = readFileSync(new URL('../../instructions/board.md', import.meta.url), 'utf8').trim();

const declared = new Set<string>(manifest.actions?.cli?.map(entry => entry.verb) ?? []);

describe('the Board instruction', () => {
  test('says exactly this', () => {
    expect(BOARD_RULE).toBe(
      'Board: opt-in, enforced; overrides other task rules. Task only if the project\'s board is on (`fy board`), under your task (`--parent`), or on the owner\'s Yes (`--approval <ask>`). Public=the owner\'s asks ("everything I asked?"): top-level, never `--private`; private=your helper tasks. Tasks (&F<n>) never ask: answers, tests, Done ride the task\'s ask on the agenda, which moves it. One outcome, no umbrellas; add to a related task. Planning is a lane. Title+summary=what it\'s doing (sitrep). Each step: `fy task show <id> --yaml`, rewrite stale title, summary, progress (PRs in doneSoFar), howToTest (where/do/see) before try, then `fy task patch <id> --file f`. `fy task move <id> <lane> --reason "<why>"`. Blocked: `fy task depend`/`block`. Owner\'s bug: `fy task reopen <id> --to <lane> --ask "<words>"`. PRs, merges, `fy signal done` self-move.',
    );
  });

  test('is for leads only: a helper is told its task rules by its own Sub-ferret section', () => {
    const entry = manifest.instructions?.find(candidate => candidate.id === 'board');
    expect(entry?.when).toEqual({ role: 'lead' });
  });

  test('names only task and board verbs this plugin declares (and the old `card` spelling nowhere)', () => {
    const named = [...BOARD_RULE.matchAll(/`fy (board|task) ([a-z-]+)/gu)].map(match => `${match[1]} ${match[2]}`);
    expect(named.length).toBeGreaterThanOrEqual(5);
    expect(declared.has('board')).toBe(true);
    for (const verb of named) expect([verb, declared.has(verb)]).toEqual([verb, true]);
    expect(declared.has('task block')).toBe(true);
    expect(BOARD_RULE).not.toMatch(/fy card\b/u);
  });

  test('the task commands the Sub-ferret and Warden texts name are declared too', () => {
    for (const verb of [
      'task show',
      'task progress',
      'task patch',
      'task note',
      'task link',
      'task claim',
      'task move',
      'task new',
      'task skip',
    ])
      expect([verb, declared.has(verb)]).toEqual([verb, true]);
  });
});
