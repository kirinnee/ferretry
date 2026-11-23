import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

/**
 * The words the Board rule puts in a lead ferret's prompt (`instructions/board.md`), pinned exactly so a change shows
 * in review, and every command it names checked against the verbs this plugin declares. The runtimes wrapper says the
 * same words (its own snapshot); this file owns them.
 */
const BOARD_RULE = readFileSync(new URL('../../instructions/board.md', import.meta.url), 'utf8').trim();

const HELPER_RULE = readFileSync(new URL('../../instructions/board-helper.md', import.meta.url), 'utf8').trim();

const declared = new Set<string>(manifest.actions?.cli?.map(entry => entry.verb) ?? []);

describe('the Board instruction', () => {
  test('says exactly this', () => {
    expect(BOARD_RULE).toBe(
      'Board: opt-in, enforced; overrides other task rules. Task only if the project\'s board is on (`fy board`), under your task (`--parent`), or on the owner\'s Yes (`--approval <ask>`). Public=the owner\'s asks ("everything I asked?"): top-level, never `--private`; private=your helper tasks. Tasks (&F<n>) never ask: answers, tests, Done ride the task\'s ask on the agenda, which moves it. One outcome, no umbrellas; add to a related task. Planning is a lane. Title+summary=what it\'s doing (sitrep). Each step: `fy task show <id> --yaml`, rewrite stale title, summary, progress (PRs in doneSoFar), howToTest (where/do/see) before try, then `fy task patch <id> --file f`. `fy task move <id> <lane> --reason "<why>"`. Blocked: `fy task depend`/`block`. Owner\'s bug: `fy task reopen <id> --to <lane> --ask "<words>"`. PRs, merges, `fy signal done` self-move. A task has no answer of its own and is named on an ask at most once ("For &F<n> Badge colour"); the owner\'s answer moves linked tasks (Done closes a tried task, Not good sends it back with their words): you are told the outcome, never move a task to stand in for an answer. After a compaction, read your task again (`fy task show <id>`) and keep its id and sitrep in the summary.',
    );
  });

  test('a helper says exactly this for its task lines', () => {
    expect(HELPER_RULE).toBe(
      "With a task: each step, `fy task show <id> --yaml`, rewrite its progress (now/doneSoFar/next, PR links) and howToTest, then `fy task patch <id> --file f`; `fy task note` adds a note. Link your PR `fy task link <id> --pr <url>` (or `--branch`); it moves itself (start, PR, merge, `fy signal done`). Lead's task? `fy task claim <id>`, don't ask. No task? Make none. After a compaction, read your task again (`fy task show <id>`) and keep its id and sitrep in the summary.",
    );
  });

  test("is Board's own, in two roles: a lead reads the whole rule, a helper its task lines", () => {
    const entries = manifest.instructions?.filter(candidate => candidate.id === 'board') ?? [];
    expect(entries.map(entry => [entry.text, entry.when])).toEqual([
      ['instructions/board.md', { role: 'lead' }],
      ['instructions/board-helper.md', { role: 'helper' }],
    ]);
  });

  test('names only task and board verbs this plugin declares (and the old `card` spelling nowhere)', () => {
    const named = [...`${BOARD_RULE} ${HELPER_RULE}`.matchAll(/`fy (board|task) ([a-z-]+)/gu)].map(
      match => `${match[1]} ${match[2]}`,
    );
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
