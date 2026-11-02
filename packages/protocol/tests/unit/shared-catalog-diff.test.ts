import { describe, expect, it } from 'bun:test';
import { type SharedCatalogItem, SharedCatalogItemSchema } from '../../src/lib/shared-catalog.ts';
import {
  CATALOG_DIFF_MAX_EDITS,
  CATALOG_DIFF_MAX_LINES,
  CATALOG_DIFF_MAX_STEPS,
  type CatalogChange,
  type CatalogChangeHunk,
  CatalogChangesSchema,
  catalogItemChanges,
  hunksOf,
  lineEdits,
  newDiffBudget,
} from '../../src/lib/shared-catalog-diff.ts';

const head = {
  format: 'ferretry-catalog-item',
  version: 1,
  publisher: `fy_daemon_${'P'.repeat(43)}`,
  catalogId: `cat_${'c'.repeat(22)}`,
  itemId: `itm_${'i'.repeat(22)}`,
  itemVersion: 1,
  name: 'thing',
  summary: 'A thing',
} as const;

const skill = (files: Readonly<Record<string, string>>): SharedCatalogItem =>
  SharedCatalogItemSchema.parse({
    ...head,
    kind: 'skill',
    skill: { files: Object.entries(files).map(([path, content]) => ({ path, content })) },
  });
const mcp = (setup: unknown): SharedCatalogItem => SharedCatalogItemSchema.parse({ ...head, kind: 'mcp', mcp: setup });
const command = (program: string, args: readonly string[] = [], env: Record<string, string> = {}): SharedCatalogItem =>
  mcp({ transport: 'command', command: program, args, env });

/** By code point, so this source holds no invisible character itself. */
const ZWSP = String.fromCodePoint(0x200b);

const lines = (count: number, prefix: string): string =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`).join('\n');

const entry = (changes: ReturnType<typeof catalogItemChanges>, label: string): CatalogChange => {
  const found = changes.entries.find(candidate => candidate.label === label);
  if (found === undefined) throw new Error(`no entry ${label}`);
  return found;
};

/** Applies hunks to the old text the way `patch` would: lines outside every hunk are kept as they are. */
const applyHunks = (before: string, hunks: readonly CatalogChangeHunk[]): string => {
  const old = before.split('\n');
  const out: string[] = [];
  let at = 0;
  for (const hunk of hunks) {
    while (at < hunk.beforeStart - 1) out.push(old[at++] as string);
    for (const line of hunk.lines) {
      if (line.kind === 'add') out.push(line.text);
      else {
        expect(old[at]).toBe(line.text);
        at += 1;
        if (line.kind === 'context') out.push(line.text);
      }
    }
  }
  while (at < old.length) out.push(old[at++] as string);
  return out.join('\n');
};

/** A small deterministic generator, so a failure names the seed that reproduces it. */
const generator = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
};

describe('catalogItemChanges', () => {
  it('says nothing changed, and counts what is the same', () => {
    const item = skill({ 'SKILL.md': 'a\nb', 'notes.md': 'x' });
    const changes = catalogItemChanges(item, item);
    expect(changes).toEqual({ entries: [], unchanged: 2, newWarnings: [], goneWarnings: [] });
    expect(CatalogChangesSchema.parse(changes)).toEqual(changes);
  });

  it('shows a changed one-line entry whole, before and after', () => {
    const changes = catalogItemChanges(command('node', ['a.js']), command('node', ['b.js']));
    expect(changes.entries).toEqual([
      { label: 'Starts', change: 'changed', document: false, before: 'node a.js', after: 'node b.js', flag: 'command' },
    ]);
  });

  it('flags what a command line or an address starts or reaches, or hands over', () => {
    const started = catalogItemChanges(command('node', ['a.js']), command('node', ['a.js'], { TOKEN: 'x' }));
    expect(entry(started, 'Environment TOKEN')).toMatchObject({ change: 'added', flag: 'command', after: 'x' });
    expect(started.unchanged).toBe(1);

    const reached = catalogItemChanges(
      mcp({ transport: 'url', url: 'https://a.example/mcp', auth: 'oauth' }),
      mcp({ transport: 'url', url: 'https://b.example/mcp', auth: 'oauth' }),
    );
    expect(reached.entries).toEqual([
      {
        label: 'Reaches',
        change: 'changed',
        document: false,
        before: 'https://a.example/mcp',
        after: 'https://b.example/mcp',
        flag: 'command',
      },
    ]);

    const dropped = catalogItemChanges(command('node', [], { TOKEN: 'x' }), command('node'));
    expect(entry(dropped, 'Environment TOKEN')).toMatchObject({ change: 'removed', before: 'x', flag: 'command' });
  });

  it('shows a changed file line by line, with three lines of context', () => {
    const before = lines(20, 'line ');
    const after = before.replace('line 10', 'line ten');
    const changes = catalogItemChanges(skill({ 'SKILL.md': before }), skill({ 'SKILL.md': after }));
    const change = entry(changes, 'Skill file SKILL.md');
    expect(change).toEqual({
      label: 'Skill file SKILL.md',
      change: 'changed',
      document: true,
      hunks: [
        {
          beforeStart: 8,
          beforeLines: 7,
          afterStart: 8,
          afterLines: 7,
          lines: [
            { kind: 'context', text: 'line 7' },
            { kind: 'context', text: 'line 8' },
            { kind: 'context', text: 'line 9' },
            { kind: 'remove', text: 'line 10' },
            { kind: 'add', text: 'line ten' },
            { kind: 'context', text: 'line 11' },
            { kind: 'context', text: 'line 12' },
            { kind: 'context', text: 'line 13' },
          ],
        },
      ],
    });
  });

  it('shows an added file and a removed file whole, with no hunks', () => {
    const changes = catalogItemChanges(
      skill({ 'SKILL.md': 'a', 'old.md': 'gone' }),
      skill({ 'SKILL.md': 'a', 'new.md': 'here\nnow' }),
    );
    expect(changes.unchanged).toBe(1);
    expect(entry(changes, 'Skill file new.md')).toEqual({
      label: 'Skill file new.md',
      change: 'added',
      document: true,
      after: 'here\nnow',
    });
    expect(entry(changes, 'Skill file old.md')).toEqual({
      label: 'Skill file old.md',
      change: 'removed',
      document: true,
      before: 'gone',
    });
  });

  it("lists the later version's entries first, then the ones only the earlier had", () => {
    const changes = catalogItemChanges(
      skill({ 'SKILL.md': 'a', 'x.md': '1' }),
      skill({ 'SKILL.md': 'b', 'y.md': '2' }),
    );
    expect(changes.entries.map(change => change.label)).toEqual([
      'Skill file SKILL.md',
      'Skill file y.md',
      'Skill file x.md',
    ]);
  });

  it('puts what deserves a second look first, and says why', () => {
    const changes = catalogItemChanges(
      skill({ 'SKILL.md': 'a', 'a.md': '1', 'run.sh': 'echo 1', tool: '#!/bin/sh\none', '.envrc': 'x' }),
      skill({ 'SKILL.md': 'b', 'a.md': '2', 'run.sh': 'echo 2', tool: '#!/bin/sh\ntwo', '.envrc': 'y' }),
    );
    expect(changes.entries.map(change => [change.label, change.flag])).toEqual([
      ['Skill file .envrc', 'runs-on-its-own'],
      ['Skill file run.sh', 'script'],
      ['Skill file tool', 'script'],
      ['Skill file SKILL.md', undefined],
      ['Skill file a.md', undefined],
    ]);
  });

  it('flags a file that is a script on only the side it exists on', () => {
    const changes = catalogItemChanges(skill({ 'SKILL.md': 'a' }), skill({ 'SKILL.md': 'a', 'run.py': 'print(1)' }));
    expect(entry(changes, 'Skill file run.py')).toMatchObject({ change: 'added', flag: 'script' });
    const gone = catalogItemChanges(skill({ 'SKILL.md': 'a', 'run.py': 'print(1)' }), skill({ 'SKILL.md': 'a' }));
    expect(entry(gone, 'Skill file run.py')).toMatchObject({ change: 'removed', flag: 'script' });
  });

  it('puts a file that runs on its own ahead of a script it also is', () => {
    const changes = catalogItemChanges(
      skill({ 'SKILL.md': 'a', '.claude/hook.sh': 'x' }),
      skill({ 'SKILL.md': 'a', '.claude/hook.sh': 'y' }),
    );
    expect(entry(changes, 'Skill file .claude/hook.sh').flag).toBe('runs-on-its-own');
  });

  it('reports the warnings a version added and the ones it took away', () => {
    const quiet = skill({ 'SKILL.md': 'a' });
    const scripted = skill({ 'SKILL.md': 'a', 'run.sh': 'echo' });
    const added = catalogItemChanges(quiet, scripted);
    expect(added.newWarnings.map(warning => warning.code)).toEqual(['carries-scripts']);
    expect(added.goneWarnings).toEqual([]);
    const removed = catalogItemChanges(scripted, quiet);
    expect(removed.newWarnings).toEqual([]);
    expect(removed.goneWarnings.map(warning => warning.code)).toEqual(['carries-scripts']);
    // The same warning with different words is a warning that went away and a new one.
    const more = catalogItemChanges(scripted, skill({ 'SKILL.md': 'a', 'run.sh': 'echo', 'two.sh': 'echo' }));
    expect(more.newWarnings).toHaveLength(1);
    expect(more.goneWarnings).toHaveLength(1);
  });

  it('diffs the review text, so a hidden character the review marks is a change a reader can see', () => {
    const changes = catalogItemChanges(skill({ 'SKILL.md': 'ship it' }), skill({ 'SKILL.md': `ship${ZWSP} it` }));
    const change = entry(changes, 'Skill file SKILL.md');
    const lines = change.hunks?.flatMap(hunk => hunk.lines) ?? [];
    expect(lines.map(line => line.kind)).toEqual(['remove', 'add']);
    // The invisible character is never carried raw: the line shows it marked.
    expect(lines[1]?.text).not.toContain(ZWSP);
    expect(lines[1]?.text).toContain('U+200B');
    expect(changes.newWarnings.map(warning => warning.code)).toContain('hidden-characters');
  });

  it('does not diff a file that needs more than the bound of edits, and says to read it whole', () => {
    const half = CATALOG_DIFF_MAX_EDITS / 2 + 1;
    const changes = catalogItemChanges(
      skill({ 'SKILL.md': lines(half, 'old ') }),
      skill({ 'SKILL.md': lines(half, 'new ') }),
    );
    expect(changes.entries).toEqual([
      { label: 'Skill file SKILL.md', change: 'changed', document: true, tooLarge: true },
    ]);
    expect(changes.truncated).toBeUndefined();
  });

  it('still diffs a file that needs exactly the bound of edits', () => {
    const half = CATALOG_DIFF_MAX_EDITS / 2;
    const changes = catalogItemChanges(
      skill({ 'SKILL.md': lines(half, 'old ') }),
      skill({ 'SKILL.md': lines(half, 'new ') }),
    );
    expect(entry(changes, 'Skill file SKILL.md').hunks).toBeDefined();
  });

  it('stops at the bound of lines for the whole answer, and says it was cut short', () => {
    const third = CATALOG_DIFF_MAX_LINES / 2 + 1;
    const changes = catalogItemChanges(
      skill({ 'SKILL.md': 'a' }),
      skill({ 'SKILL.md': 'a', 'one.md': lines(third, 'x'), 'two.md': lines(third, 'y'), 'three.md': 'z' }),
    );
    expect(changes.truncated).toBe(true);
    expect(entry(changes, 'Skill file one.md').after).toBeDefined();
    expect(entry(changes, 'Skill file two.md')).toEqual({
      label: 'Skill file two.md',
      change: 'added',
      document: true,
      tooLarge: true,
    });
    // The small one after it still fits.
    expect(entry(changes, 'Skill file three.md').after).toBe('z');
    expect(CatalogChangesSchema.parse(changes)).toEqual(changes);
  });

  it('keeps the flag on an entry it left out', () => {
    const third = CATALOG_DIFF_MAX_LINES / 2 + 1;
    const changes = catalogItemChanges(
      skill({ 'SKILL.md': 'a' }),
      skill({ 'SKILL.md': 'a', 'one.md': lines(third, 'x'), 'run.sh': lines(third, 'y') }),
    );
    expect(entry(changes, 'Skill file one.md').tooLarge).toBe(true);
    expect(entry(changes, 'Skill file run.sh')).toMatchObject({ after: expect.any(String), flag: 'script' });
    expect(changes.truncated).toBe(true);
  });

  it('compares items of different kinds without failing', () => {
    const changes = catalogItemChanges(skill({ 'SKILL.md': 'a' }), command('node'));
    expect(changes.entries.map(change => [change.label, change.change])).toEqual([
      ['Starts', 'added'],
      ['Skill file SKILL.md', 'removed'],
    ]);
  });
});

describe('lineEdits and hunksOf', () => {
  it('trims what both sides share before searching', () => {
    const edits = lineEdits(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd'], 10);
    expect(edits?.map(edit => `${edit.kind}:${edit.text}`)).toEqual([
      'context:a',
      'remove:b',
      'add:x',
      'context:c',
      'context:d',
    ]);
  });

  it('answers nothing when the shortest script is longer than the limit', () => {
    expect(lineEdits(['a', 'b'], ['c', 'd'], 3)).toBeUndefined();
    expect(lineEdits(['a', 'b'], ['c', 'd'], 4)).toBeDefined();
  });

  it('handles an empty side and two empty sides', () => {
    expect(lineEdits([], [], 10)).toEqual([]);
    expect(lineEdits([], ['a'], 10)).toEqual([{ kind: 'add', text: 'a' }]);
    expect(lineEdits(['a'], [], 10)).toEqual([{ kind: 'remove', text: 'a' }]);
  });

  it('makes no hunk when nothing changed, and one hunk per distant change', () => {
    expect(hunksOf([{ kind: 'context', text: 'a' }])).toEqual([]);
    const before = lines(30, 'l');
    const after = before.replace('l2\n', '').replace('l25\n', '');
    const edits = lineEdits(before.split('\n'), after.split('\n'), 100) ?? [];
    const hunks = hunksOf(edits);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ beforeStart: 1, afterStart: 1 });
    expect(hunks[1]?.beforeStart).toBe(23);
  });

  it('merges changes that are close enough to share their context', () => {
    const before = lines(12, 'l');
    const after = before.replace('l2\n', '').replace('l7\n', '');
    const hunks = hunksOf(lineEdits(before.split('\n'), after.split('\n'), 100) ?? []);
    expect(hunks).toHaveLength(1);
  });

  it('puts the start of an empty side at the insertion point', () => {
    const hunks = hunksOf(lineEdits(['a', 'b'], ['a', 'b', 'c'], 10) ?? []);
    expect(hunks).toEqual([
      {
        beforeStart: 1,
        beforeLines: 2,
        afterStart: 1,
        afterLines: 3,
        lines: [
          { kind: 'context', text: 'a' },
          { kind: 'context', text: 'b' },
          { kind: 'add', text: 'c' },
        ],
      },
    ]);
    expect(hunksOf(lineEdits([''], ['', 'x'], 10) ?? [])[0]?.beforeStart).toBe(1);
  });
});

describe('the hunks are the difference', () => {
  it('applied to the old text give the new text, for any pair of texts', () => {
    const alphabet = ['a', 'b', 'c', 'd', 'e', ''];
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = generator(seed);
      const text = (): string =>
        Array.from(
          { length: Math.floor(next() * 40) },
          () => alphabet[Math.floor(next() * alphabet.length)] as string,
        ).join('\n');
      const before = text();
      const after =
        next() < 0.5
          ? text()
          : before
              .split('\n')
              .filter(() => next() < 0.8)
              .join('\n');
      const changes = catalogItemChanges(skill({ 'SKILL.md': before || 'x' }), skill({ 'SKILL.md': after || 'x' }));
      const oldText = before || 'x';
      const newText = after || 'x';
      if (oldText === newText) {
        expect(changes.entries).toEqual([]);
        continue;
      }
      const change = entry(changes, 'Skill file SKILL.md');
      expect(applyHunks(oldText, change.hunks ?? [])).toBe(newText);
      for (const hunk of change.hunks ?? []) {
        expect(hunk.lines.filter(line => line.kind !== 'add')).toHaveLength(hunk.beforeLines);
        expect(hunk.lines.filter(line => line.kind !== 'remove')).toHaveLength(hunk.afterLines);
      }
    }
  });

  it('holds for a long file with scattered edits', () => {
    const next = generator(7);
    const before = Array.from({ length: 600 }, (_, index) => `row ${index}`);
    const after = before.flatMap(row => (next() < 0.05 ? [] : next() < 0.05 ? [row, `${row} extra`] : [row]));
    const change = entry(
      catalogItemChanges(skill({ 'SKILL.md': before.join('\n') }), skill({ 'SKILL.md': after.join('\n') })),
      'Skill file SKILL.md',
    );
    expect(applyHunks(before.join('\n'), change.hunks ?? [])).toBe(after.join('\n'));
  });
});

describe('the work one answer may spend', () => {
  /** `count` files, each `size` lines whose every line differs between the two sides. */
  const pathological = (count: number, size: number): [SharedCatalogItem, SharedCatalogItem] => [
    skill(
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [index === 0 ? 'SKILL.md' : `f${index}.md`, lines(size, 'o')]),
      ),
    ),
    skill(
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [index === 0 ? 'SKILL.md' : `f${index}.md`, lines(size, 'n')]),
      ),
    ),
  ];

  it('gives up at once when the two lengths differ by more than the limit, spending nothing', () => {
    const budget = newDiffBudget();
    const long = Array.from({ length: CATALOG_DIFF_MAX_EDITS + 1 }, (_, index) => `line ${index}`);
    expect(lineEdits(long, [], CATALOG_DIFF_MAX_EDITS, budget)).toBeUndefined();
    expect(lineEdits([], long, CATALOG_DIFF_MAX_EDITS, budget)).toBeUndefined();
    expect(budget.remaining).toBe(CATALOG_DIFF_MAX_STEPS);
    expect(lineEdits(long.slice(0, 3), [], CATALOG_DIFF_MAX_EDITS, budget)).toBeDefined();
  });

  it('spends the same budget across files, then leaves every later file undiffed and says so', () => {
    // Each of these needs exactly the bound of edits: diffable alone, and about 8 million steps each.
    const [before, after] = pathological(12, CATALOG_DIFF_MAX_EDITS / 2);
    const budget = newDiffBudget();
    const changes = catalogItemChanges(before, after, budget);
    const diffed = changes.entries.filter(candidate => candidate.hunks !== undefined);
    expect(diffed).toHaveLength(3);
    expect(changes.entries.filter(candidate => candidate.tooLarge === true)).toHaveLength(9);
    expect(changes.truncated).toBe(true);
    expect(CATALOG_DIFF_MAX_STEPS - budget.remaining).toBeLessThanOrEqual(CATALOG_DIFF_MAX_STEPS + 1);
    expect(CatalogChangesSchema.safeParse(changes).success).toBe(true);
  });

  it('bounds an item of many files that each need more than the limit, by steps and not by clock', () => {
    const [before, after] = pathological(150, CATALOG_DIFF_MAX_EDITS / 2 + 1);
    const budget = newDiffBudget();
    const changes = catalogItemChanges(before, after, budget);
    expect(changes.entries).toHaveLength(150);
    expect(changes.entries.every(candidate => candidate.tooLarge === true)).toBe(true);
    expect(changes.truncated).toBe(true);
    expect(CATALOG_DIFF_MAX_STEPS - budget.remaining).toBeLessThanOrEqual(CATALOG_DIFF_MAX_STEPS + 1);
  });

  it('does not say truncated when the budget was not spent', () => {
    const budget = newDiffBudget();
    const changes = catalogItemChanges(skill({ 'SKILL.md': 'a\nb' }), skill({ 'SKILL.md': 'a\nc' }), budget);
    expect(changes.truncated).toBeUndefined();
    expect(budget.remaining).toBeGreaterThan(CATALOG_DIFF_MAX_STEPS - 100);
  });
});

describe('a carriage return at the end of a line', () => {
  it('is written out, so a CRLF file turned into an LF file is a change a reader can see', () => {
    const changes = catalogItemChanges(skill({ 'SKILL.md': 'one\r\ntwo\r\n' }), skill({ 'SKILL.md': 'one\ntwo\n' }));
    const hunks = entry(changes, 'Skill file SKILL.md').hunks ?? [];
    const texts = hunks.flatMap(hunk => hunk.lines.map(line => `${line.kind}:${line.text}`));
    expect(texts).toContain('remove:one⟨U+000D⟩');
    expect(texts).toContain('add:one');
    expect(texts).toContain('remove:two⟨U+000D⟩');
  });

  it('is marked once, not twice, when the review already marked one in the middle of a line', () => {
    const changes = catalogItemChanges(skill({ 'SKILL.md': 'a\rb\nc' }), skill({ 'SKILL.md': 'a\rb\nd' }));
    const texts = (entry(changes, 'Skill file SKILL.md').hunks ?? []).flatMap(hunk =>
      hunk.lines.map(line => line.text),
    );
    expect(texts).toContain('a⟨U+000D⟩b');
  });
});
