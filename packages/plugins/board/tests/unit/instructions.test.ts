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
      'Board: opt-in, enforced; overrides other card rules. Card only if the project\'s board is on (`fy board`), under your card (`--parent`), or on the owner\'s Yes (`--approval <ask>`). Public=the owner\'s asks ("everything I asked?"): top-level, never `--private`; private=your helper cards. Cards (&F<n>) never ask: answers, tests, Done ride the card\'s ask on the agenda, which moves it. One outcome, no umbrellas; add to a related card. Planning is a lane. Title+summary=what it\'s doing (sitrep). Each step: `fy card show <id> --yaml`, rewrite stale title, summary, progress (PRs in doneSoFar), howToTest (where/do/see) before try, then `fy card patch <id> --file f`. `fy card move <id> <lane> --reason "<why>"`. Blocked: `fy card depend`/`block`. Owner\'s bug: `fy card reopen <id> --to <lane> --ask "<words>"`. PRs, merges, `fy signal done` self-move.',
    );
  });

  test('is for leads only: a helper is told its card rules by its own Sub-ferret section', () => {
    const entry = manifest.instructions?.find(candidate => candidate.id === 'board');
    expect(entry?.when).toEqual({ role: 'lead' });
  });

  test('names only card and board verbs this plugin declares (and the retired `task` verbs nowhere)', () => {
    const named = [...BOARD_RULE.matchAll(/`fy (board|card) ([a-z-]+)/gu)].map(match => `${match[1]} ${match[2]}`);
    expect(named.length).toBeGreaterThanOrEqual(5);
    expect(declared.has('board')).toBe(true);
    for (const verb of named) expect([verb, declared.has(verb)]).toEqual([verb, true]);
    expect(declared.has('card block')).toBe(true);
    expect(BOARD_RULE).not.toMatch(/fy task\b/u);
  });

  test('the card commands the Sub-ferret and Warden texts name are declared too', () => {
    for (const verb of [
      'card show',
      'card progress',
      'card patch',
      'card note',
      'card link',
      'card claim',
      'card move',
      'card new',
      'card skip',
    ])
      expect([verb, declared.has(verb)]).toEqual([verb, true]);
  });
});
