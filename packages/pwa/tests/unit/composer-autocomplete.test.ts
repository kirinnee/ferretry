import { describe, test } from 'bun:test';
import should from 'should';
import {
  COMPOSER_REFERENCE_TIERS,
  type ComposerAutocompleteCandidate,
  type ComposerSelection,
  type ComposerSuggestionSwitches,
  type ComposerTriggerMatch,
  composerSuggestionsAllow,
  DEFAULT_COMPOSER_SUGGESTIONS,
  detectComposerTrigger,
  MAX_AUTOCOMPLETE_RESULTS,
  nextComposerCandidateIndex,
  pendingComposerInputSelection,
  rankComposerCandidates,
  replaceComposerTrigger,
  type TokenReplacement,
} from '../../src/components/composer-autocomplete.ts';
import { findReferences } from '../../src/lib/references.ts';

const caret = (at: number): ComposerSelection => ({ start: at, end: at });

const detect = (value: string, at = value.length): ComposerTriggerMatch | null =>
  detectComposerTrigger(value, caret(at));

/** Detects and asserts a trigger opened, so replacement cases stay readable. */
const detected = (value: string, at = value.length): ComposerTriggerMatch => {
  const match = detect(value, at);
  if (match === null) throw new Error(`no trigger detected in ${JSON.stringify(value)}`);
  return match;
};

const candidate = (
  id: string,
  label: string,
  patch: Partial<ComposerAutocompleteCandidate> = {},
): ComposerAutocompleteCandidate => ({ id, label, kind: 'skill', replacement: `/${id}`, ...patch });

describe('COMPOSER_REFERENCE_TIERS', () => {
  test('should list the four families in frequency order, sigil run matching tier', () => {
    // Assert — kept as data so provider routing, UI teaching and tests cannot drift.
    should(COMPOSER_REFERENCE_TIERS.map(item => item.label)).deepEqual(['Files', 'Agents', 'Tasks', 'Attention']);
    should(COMPOSER_REFERENCE_TIERS.every(item => item.trigger === '@'.repeat(item.tier))).equal(true);
  });

  test('should admit no fifth tier, for pins, templates or anything else', () => {
    // Assert — the ladder is a closed set. Pins are a link strip (#63) and no
    // build of this app has ever had a template library; both have arrived as
    // proposed `@` tiers before, and this list is the guard.
    should(COMPOSER_REFERENCE_TIERS).have.length(4);
    should(COMPOSER_REFERENCE_TIERS.some(item => /pin|template/iu.test(item.label))).equal(false);
    should(detect('line\n@@@@@pin')).match({ referenceTier: 5 });
  });

  test('should name each family the direct sigil that opens it, files excepted', () => {
    // Assert — one table, read from both ends: the ladder teaches it and the
    // direct providers route by it.
    should(COMPOSER_REFERENCE_TIERS.map(item => item.direct)).deepEqual([undefined, ':', '&', '!']);
  });
});

describe('pendingComposerInputSelection', () => {
  test('should not clamp a new input caret against the previous controlled value', () => {
    // Act — the composer still renders value="" while the input event for "/" reports caret 1.
    const actual = pendingComposerInputSelection({ start: 1, end: 1 });

    // Assert
    should(actual).deepEqual({ start: 1, end: 1 });
  });

  test('should keep the selection ordered and non-negative', () => {
    // Act & Assert
    should(pendingComposerInputSelection({ start: -4, end: -9 })).deepEqual({ start: 0, end: 0 });
    should(pendingComposerInputSelection({ start: 6.7, end: 2 })).deepEqual({ start: 6, end: 6 });
  });
});

describe('detectComposerTrigger for /', () => {
  test('should open only as the first non-whitespace token', () => {
    // Act & Assert
    should(detect('/')).match({ trigger: '/', query: '', start: 0, end: 1 });
    should(detect('  /sum')).match({ trigger: '/', query: 'sum', start: 2, end: 6 });
    should(detect('hello /sum')).be.null();
    should(detect('https://example.test', 8)).be.null();
  });

  test('should close on a space rather than turn prose into a command query', () => {
    // Act & Assert
    should(detect('/summary now')).be.null();
    should(detect('/ ')).be.null();
  });

  test('should stay closed until the caret is past the sigil', () => {
    // Act & Assert
    should(detect('/sum', 0)).be.null();
  });

  test('should report nothing for an empty or all-whitespace draft', () => {
    // Act & Assert
    should(detect('')).be.null();
    should(detect('   ')).be.null();
  });
});

describe('detectComposerTrigger for @', () => {
  test('should open anywhere in the whitespace-free token at the caret', () => {
    // Act & Assert
    should(detect('@')).match({ trigger: '@', triggerText: '@', referenceTier: 1, query: '', start: 0, end: 1 });
    should(detect('read @src/app.ts')).match({ trigger: '@', query: 'src/app.ts', start: 5, end: 16 });
    should(detect('see:@src')).match({ trigger: '@', start: 4, query: 'src' });
  });

  test('should close as soon as whitespace ends the token', () => {
    // Act & Assert
    should(detect('read @src next')).be.null();
  });

  const tiers = [
    { value: '@', triggerText: '@', tier: 1, query: '', start: 0 },
    { value: '@src/app', triggerText: '@', tier: 1, query: 'src/app', start: 0 },
    { value: '@@ott', triggerText: '@@', tier: 2, query: 'ott', start: 0 },
    { value: 'see @@@F12', triggerText: '@@@', tier: 3, query: 'F12', start: 4 },
    { value: 'resolve @@@@A3', triggerText: '@@@@', tier: 4, query: 'A3', start: 8 },
  ];

  for (const { value, triggerText, tier, query, start } of tiers) {
    test(`should open the repetition-selected tier for ${JSON.stringify(value)}`, () => {
      // Act & Assert
      should(detect(value)).match({
        trigger: '@',
        triggerText,
        referenceTier: tier,
        query,
        start,
        end: value.length,
      });
    });
  }

  test('should change tier on an extra sigil without breaking the active token', () => {
    // Act & Assert
    should(detect('@@')).match({ referenceTier: 2, query: '' });
    should(detect('@@ott')).match({ referenceTier: 2, query: 'ott' });
    should(detect('@@@ott')).match({ referenceTier: 3, query: 'ott' });
    // An unknown run still opens so the legend can teach the four supported
    // families instead of making the fifth sigil look broken.
    should(detect('@@@@@@')).match({ referenceTier: 6, query: '' });
  });

  test('should extend the replace span beyond a caret in the middle of a token', () => {
    // Act & Assert
    should(detect('read @src/old.ts please', 9)).match({ trigger: '@', query: 'src', start: 5, end: 16 });
  });

  test('should require the sigil to begin its token', () => {
    // Act & Assert — `match.start` is the sigil, so a false positive here would
    // replace `@example.com` and weld `bob` to a path.
    should(detect('mail bob@example.com')).be.null();
    should(detect('a.b@c')).be.null();
    should(detect('user1@x')).be.null();
    should(detect('foo@bar')).be.null();
    should(detect('dir/x@y')).be.null();
  });

  test('should treat whitespace and opening punctuation as boundaries', () => {
    // Act & Assert
    should(detect('@src')).match({ query: 'src', start: 0 });
    should(detect('see @src')).match({ query: 'src', start: 4 });
    should(detect('see:@src')).match({ query: 'src', start: 4 });
    should(detect('(@src')).match({ query: 'src', start: 1 });
    should(detect('line\n@src')).match({ query: 'src', start: 5 });
    should(detect('tab\t@src')).match({ query: 'src', start: 4 });
  });

  test('should keep scanning left when the nearest sigil is glued to a word', () => {
    // Act — the trailing `@` fails the boundary test; the leading one opens the token.
    const actual = detect('@src/a@b');

    // Assert
    should(actual).match({ trigger: '@', triggerText: '@', query: 'src/a@b', start: 0 });
  });
});

describe('detectComposerTrigger for %', () => {
  test('should open one surface token at a boundary, with no tier', () => {
    // Act & Assert
    should(detect('%')).match({ trigger: '%', triggerText: '%', query: '', start: 0, end: 1 });
    should(detect('drive %terminal:ab12')).match({ trigger: '%', query: 'terminal:ab12', start: 6, end: 20 });
    should(detect('(%term')).match({ trigger: '%', query: 'term', start: 1 });
    should(detect('%terminal:ab12')?.referenceTier).be.undefined();
  });

  test('should close as soon as whitespace ends the token', () => {
    // Act & Assert
    should(detect('%terminal:ab12 next')).be.null();
  });

  test('should read a percentage as prose, never as a surface offer', () => {
    // Act & Assert — a digit or a letter before the sigil is a word, not a boundary.
    should(detect('cpu hit 50%')).be.null();
    should(detect('a%b')).be.null();
  });

  test('should refuse a repeated sigil, because repetition selects nothing here', () => {
    // Act & Assert
    should(detect('%%term')).be.null();
  });

  test('should leave a path containing a percent sign as one file query', () => {
    // Act & Assert
    should(detect('@src/a%b')).match({ trigger: '@', query: 'src/a%b', start: 0 });
  });
});

describe('detectComposerTrigger backward scan', () => {
  // A rejected candidate at index 0 used to restart the scan on itself, because
  // `lastIndexOf(sigil, -1)` answers 0 rather than -1. The composer — and the tab
  // with it — froze on a draft as ordinary as `@a b`. These cases must RETURN.
  const settled = ['@a b', '%a b', '@@ x', '@ ', '% ', '@src/a b', '%terminal:ab12 next'];

  for (const value of settled) {
    test(`should terminate rather than rescan the leading sigil in ${JSON.stringify(value)}`, () => {
      // Act & Assert — reaching the assertion at all is the regression.
      should(detect(value)).be.null();
    });
  }
});

describe('detectComposerTrigger for the direct family sigils', () => {
  const direct = [
    { value: ':zel', trigger: ':', query: 'zel', start: 0 },
    { value: 'ask :zelda', trigger: ':', query: 'zelda', start: 4 },
    { value: 'track &F1', trigger: '&', query: 'F1', start: 6 },
    { value: '&F12', trigger: '&', query: 'F12', start: 0 },
    { value: 'resolve !A3', trigger: '!', query: 'A3', start: 8 },
    { value: 'run $sum', trigger: '$', query: 'sum', start: 4 },
    { value: '(:zel', trigger: ':', query: 'zel', start: 1 },
    { value: 'line\n&B7', trigger: '&', query: 'B7', start: 5 },
  ];

  for (const { value, trigger, query, start } of direct) {
    test(`should open the family menu for ${JSON.stringify(value)}`, () => {
      // Act & Assert — no tier: a direct sigil selects its family outright.
      should(detect(value)).match({ trigger, triggerText: trigger, query, start, end: value.length });
      should(detect(value)?.referenceTier).be.undefined();
    });
  }

  test('should stay shut until at least one query character exists', () => {
    // Act & Assert — a bare sigil is prose far more often than it is an intent,
    // and an empty-query menu would answer Enter for a reader who typed `A & `.
    should(detect(':')).be.null();
    should(detect('see &')).be.null();
    should(detect('yes!')).be.null();
    should(detect('costs $')).be.null();
  });

  test('should refuse anything the reference grammar itself would refuse', () => {
    // Act & Assert — the picker never offers a token the renderer cannot prove.
    should(detect('$HOME')).be.null();
    should(detect('echo $PATH')).be.null();
    should(detect('&x1')).be.null();
    should(detect('!B3')).be.null();
    should(detect('!a3')).be.null();
    should(detect(':1zelda')).be.null();
  });

  test('should require the grammar’s own left boundary, not a wider one', () => {
    // Act & Assert — `note:` and `US$5` are words; the sigil must BEGIN a token.
    should(detect('note:zelda')).be.null();
    should(detect('a:b')).be.null();
    should(detect('R&D3')).be.null();
    should(detect('US$5')).be.null();
    should(detect('done!A3')).be.null();
  });

  test('should answer about the sigil nearest the caret', () => {
    // Act & Assert — a draft can hold several; the one being typed wins.
    should(detect('ask :zelda about &F1')).match({ trigger: '&', query: 'F1', start: 17 });
    should(detect('ask :zelda about &F1', 10)).match({ trigger: ':', query: 'zelda', start: 4 });
  });

  test('should keep scanning left and settle when no earlier sigil qualifies', () => {
    // Act & Assert — the trailing `:` is glued to a word, and the leading one
    // now owns a query the grammar refuses, so neither opens anything.
    should(detect(':zelda:x')).be.null();
  });

  test('should insert a token this build can prove, for every family', () => {
    // Arrange — what the picker replaces the token with has to be a reference.
    const cases: readonly [string, string][] = [
      [':zel', ':zelda'],
      ['&F1', '&F12'],
      ['!A', '!A3'],
      ['$sum', '/summary'],
    ];

    for (const [draft, replacement] of cases) {
      // Act
      const actual = replaceComposerTrigger(draft, detected(draft), replacement);

      // Assert
      should(actual.value).equal(`${replacement} `);
      should(findReferences(actual.value).map(found => found.raw)).deepEqual([replacement]);
    }
  });

  test('should let the surface and file grammars keep their own interior colons', () => {
    // Act & Assert — `%` and `@` are tried first precisely for this.
    should(detect('%terminal:ab12')).match({ trigger: '%', query: 'terminal:ab12' });
    should(detect('@src/api.ts:120')).match({ trigger: '@', query: 'src/api.ts:120' });
  });

  test('should terminate rather than rescan a rejected leading sigil', () => {
    // Act & Assert — the `lastIndexOf(-1)` freeze, once per new sigil.
    for (const value of [':a b', '&F1 x', '!A3 x', '$a b', ':: ', '&& ']) should(detect(value)).be.null();
  });
});

describe('detectComposerTrigger refusals', () => {
  const prose = [
    'Is this right?',
    'Do you know?A3',
    '?',
    '?a3',
    '#',
    '# Heading',
    '## Heading',
    '#fff',
    '#123',
    'issue (#123)',
    'see #F12',
    '&',
    '?A3',
    'resolve ?A3',
    'Tom & Jerry',
    'R&D',
    'a && b',
    'foo#L12',
  ];

  for (const value of prose) {
    test(`should leave ${JSON.stringify(value)} as ordinary prose or markdown`, () => {
      // Act & Assert — tasks and attention are browsed through `@`; their
      // canonical inserted forms are never themselves triggers.
      should(detect(value)).be.null();
    });
  }

  test('should never open on a non-collapsed textarea selection', () => {
    // Act & Assert
    should(detectComposerTrigger('/summary', { start: 1, end: 4 })).be.null();
    should(detectComposerTrigger('@src', { start: 0, end: 4 })).be.null();
    should(detectComposerTrigger('@F12', { start: 1, end: 4 })).be.null();
  });

  test('should clamp a selection that runs past the draft', () => {
    // Act & Assert — a caret beyond the value is still the end of the value.
    should(detectComposerTrigger('@src', { start: 99, end: 99 })).match({ query: 'src', start: 0 });
    should(detectComposerTrigger('@src', { start: -3, end: -3 })).be.null();
  });

  test('should read ! as Attention only, never as the shell mode it once was', () => {
    // Act & Assert — `!A3` opens the Attention family; a command line does not
    // open anything, and there is no dormant branch that could run one.
    should(detect('!')).be.null();
    should(detect('!git status')).be.null();
    should(detect('!ls')).be.null();
    should(detect('!A3')).match({ trigger: '!', query: 'A3' });
  });
});

describe('replaceComposerTrigger', () => {
  test('should replace the whole token and leave one separating space', () => {
    // Act
    const actual: TokenReplacement = replaceComposerTrigger('/summry', detected('/summry'), '/summary');

    // Assert
    should(actual).deepEqual({ value: '/summary ', selection: { start: 9, end: 9 } });
  });

  test('should allow a replacement that changes the sigil entirely', () => {
    // Act — Codex invokes a skill as `$name`, not `/name`.
    const actual = replaceComposerTrigger('/sum', detected('/sum'), '$summary');

    // Assert
    should(actual).deepEqual({ value: '$summary ', selection: { start: 9, end: 9 } });
  });

  test('should keep a directory token open without adding a space', () => {
    // Act
    const actual = replaceComposerTrigger('look @sr', detected('look @sr'), '@src/', 'none');

    // Assert
    should(actual).deepEqual({ value: 'look @src/', selection: { start: 10, end: 10 } });
  });

  test('should replace the suffix instead of duplicating it when accepting mid-token', () => {
    // Arrange
    const value = 'read @src/old.ts please';

    // Act
    const actual = replaceComposerTrigger(value, detected(value, 9), '@src/new.ts');

    // Assert
    should(actual).deepEqual({ value: 'read @src/new.ts please', selection: { start: 17, end: 17 } });
  });

  test('should reuse existing whitespace rather than double it', () => {
    // Act
    const actual = replaceComposerTrigger('@old file', detected('@old file', 4), '@new.ts');

    // Assert
    should(actual).deepEqual({ value: '@new.ts file', selection: { start: 8, end: 8 } });
  });

  test('should leave a non-space separator exactly as the reader typed it', () => {
    // Act — a newline already separates the token; adding a space would move the break.
    const actual = replaceComposerTrigger('@old\nnext', detected('@old\nnext', 4), '@new.ts');

    // Assert
    should(actual).deepEqual({ value: '@new.ts\nnext', selection: { start: 7, end: 7 } });
  });

  test('should insert the canonical reference syntax for the task and attention tiers', () => {
    // Act
    const task = replaceComposerTrigger('track @@@F1', detected('track @@@F1'), '&F12');
    const attention = replaceComposerTrigger('resolve @@@@A', detected('resolve @@@@A'), '!A3');

    // Assert — the browse trigger is `@`; what lands in the draft is the grammar
    // `findReferences` parses.
    should(task).deepEqual({ value: 'track &F12 ', selection: { start: 11, end: 11 } });
    should(attention).deepEqual({ value: 'resolve !A3 ', selection: { start: 12, end: 12 } });
  });
});

describe('composerSuggestionsAllow', () => {
  const off = (patch: Partial<ComposerSuggestionSwitches>): ComposerSuggestionSwitches => ({
    ...DEFAULT_COMPOSER_SUGGESTIONS,
    ...patch,
  });
  const allow = (suggestions: ComposerSuggestionSwitches, value: string): boolean => {
    const match = detect(value);
    if (match === null) throw new Error(`no trigger detected in ${JSON.stringify(value)}`);
    return composerSuggestionsAllow(suggestions, match);
  };

  test('should offer every family by default', () => {
    // Act & Assert
    should(DEFAULT_COMPOSER_SUGGESTIONS).deepEqual({
      mentionSuggestions: true,
      directReferenceSuggestions: true,
      skillSuggestions: true,
    });
    for (const value of ['@sr', '@@ott', ':zel', '&F1', '!A3', '$sum', '/sum', '%term'])
      should(allow(DEFAULT_COMPOSER_SUGGESTIONS, value)).equal(true);
  });

  test('should suppress the whole @ ladder, bare @ included', () => {
    // Act & Assert — the Settings switch names all four tiers, so exempting
    // tier 1 would make its own copy untrue.
    const suggestions = off({ mentionSuggestions: false });
    for (const value of ['@src', '@@ott', '@@@F12', '@@@@A3']) should(allow(suggestions, value)).equal(false);
    should(allow(suggestions, ':zel')).equal(true);
  });

  test('should suppress the three direct sigils together and nothing else', () => {
    // Act & Assert
    const suggestions = off({ directReferenceSuggestions: false });
    for (const value of [':zel', '&F1', '!A3']) should(allow(suggestions, value)).equal(false);
    for (const value of ['$sum', '/sum', '@@ott', '%term']) should(allow(suggestions, value)).equal(true);
  });

  test('should suppress $ while / keeps every skill reachable', () => {
    // Act & Assert — the asymmetry is the point: a switch removes a second way
    // in, never the only one.
    const suggestions = off({ skillSuggestions: false });
    should(allow(suggestions, '$sum')).equal(false);
    should(allow(suggestions, '/sum')).equal(true);
  });
});

describe('rankComposerCandidates', () => {
  test('should rank a name match above a description-only match', () => {
    // Arrange
    const rows = [
      candidate('description', 'other', { detail: 'Summarize this conversation' }),
      candidate('name', 'summary', { detail: 'Fast recap' }),
    ];

    // Act & Assert
    should(rankComposerCandidates(rows, 'sum').map(row => row.id)).deepEqual(['name', 'description']);
  });

  test('should keep small named reference sets ahead of filesystem matches', () => {
    // Arrange
    const rows = [
      candidate('file', 'ottis.ts', { kind: 'file', replacement: '@ottis.ts' }),
      candidate('agent', 'ottis', { kind: 'agent', rankPriority: 1, replacement: 'agent-ref' }),
    ];

    // Act & Assert
    should(rankComposerCandidates(rows, 'ottis').map(row => row.id)).deepEqual(['agent', 'file']);
  });

  test('should match fuzzy subsequences and drop candidates that do not match at all', () => {
    // Arrange
    const rows = [candidate('front', 'frontend-design'), candidate('summary', 'summary'), candidate('miss', 'deploy')];

    // Act & Assert
    should(rankComposerCandidates(rows, 'frtd').map(row => row.id)).deepEqual(['front']);
  });

  test('should admit a keywords-only match that neither label nor detail carries', () => {
    // Arrange
    const rows = [candidate('kw', 'deploy', { keywords: 'ship release rollout' })];

    // Act & Assert
    should(rankComposerCandidates(rows, 'rollout').map(row => row.id)).deepEqual(['kw']);
  });

  test('should preserve provider order and cap DOM work for an empty query', () => {
    // Arrange
    const rows = Array.from({ length: MAX_AUTOCOMPLETE_RESULTS + 10 }, (_, index) =>
      candidate(String(index), `skill-${index}`),
    );

    // Act
    const ranked = rankComposerCandidates(rows, '');

    // Assert
    should(ranked).have.length(MAX_AUTOCOMPLETE_RESULTS);
    should(ranked[0]?.id).equal('0');
  });

  test('should honour an explicit limit', () => {
    // Act & Assert
    should(rankComposerCandidates([candidate('a', 'alpha'), candidate('b', 'alps')], 'al', 1)).have.length(1);
  });
});

describe('nextComposerCandidateIndex', () => {
  const rows = [candidate('a', 'a'), candidate('blocked', '.env', { disabled: true }), candidate('c', 'c')];

  test('should wrap and skip refused file rows', () => {
    // Act & Assert
    should(nextComposerCandidateIndex(rows, 0, 1)).equal(2);
    should(nextComposerCandidateIndex(rows, 2, 1)).equal(0);
    should(nextComposerCandidateIndex(rows, 0, -1)).equal(2);
  });

  test('should read "nothing selected" as the first row down and the last row up', () => {
    // Act & Assert
    should(nextComposerCandidateIndex(rows, -1, 1)).equal(0);
    should(nextComposerCandidateIndex(rows, -1, -1)).equal(2);
  });

  test('should report no selectable index for an information-only result', () => {
    // Act & Assert
    should(nextComposerCandidateIndex([candidate('blocked', '.env', { disabled: true })], -1, 1)).equal(-1);
    should(nextComposerCandidateIndex([], -1, 1)).equal(-1);
  });
});
