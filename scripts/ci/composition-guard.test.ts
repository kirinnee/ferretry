import { afterEach, describe as suite, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTwoAdds } from '../gen/tests/merge-safe.ts';
import {
  type FileChange,
  describe,
  evaluate,
  isLedgerClosing,
  isSortedAdd,
  parseDiff,
  run,
} from './composition-guard.ts';
import {
  COMPOSITION_HEADER,
  type CompositionEntry,
  checkPaths,
  guarded,
  parseComposition,
  readDeclared,
} from './lib/composition.ts';
import { packageRoots } from './one-folder.ts';

const entry = (path: string, kind: CompositionEntry['kind'] = 'composition'): CompositionEntry => ({
  kind,
  path,
  owner: 'packages/core/ferrets',
  limit: '-',
  expires: '-',
  reason: 'a seam',
  line: 2,
});
const DECLARED = new Map(
  [
    entry('packages/core/ferrets/manifest.ts'),
    entry('packages/core/ferrets/ports-pending.json'),
    entry('packages/core/ferrets/daemon/harness/parts/index.ts', 'registry'),
  ].map(item => [item.path, item] as const),
);

const edit = (added: string[], removed: string[], addedAt = 1, head: string[] | undefined = ['x']): FileChange => ({
  added,
  removed,
  addedAt,
  head,
});
const body = (...lines: string[]): string => ['Some summary.', '', ...lines].join('\n');
const check = (changes: Record<string, FileChange>, text = '') =>
  evaluate({ declared: DECLARED, changes: new Map(Object.entries(changes)), body: text });

// ─── the rule, pure ──────────────────────────────────────────────────────────────────────────────────────────────

suite('the guard decides', () => {
  test('passes when no declared file is edited', () => {
    const result = check({ 'packages/core/ferrets/daemon/lib/ferrets/other.ts': edit(['a'], ['b']) });
    expect(result.ok).toBe(true);
    expect(result.edited).toEqual([]);
    expect(describe(result).join('\n')).toContain('No composition file is edited');
  });

  test('fails on an edit of a composition file without the section, and says which file and what to add', () => {
    const result = check({ 'packages/core/ferrets/manifest.ts': edit(['a'], ['b']) });
    expect(result.ok).toBe(false);
    expect(result.missing.map(item => item.file)).toEqual(['packages/core/ferrets/manifest.ts']);
    const text = describe(result).join('\n');
    expect(text).toContain('✗ packages/core/ferrets/manifest.ts');
    expect(text).toContain('## Contract change');
    expect(text).toContain('- packages/core/ferrets/manifest.ts: why this PR has to change it');
  });

  test('passes when the body names the file with a reason, in every spelling of an entry', () => {
    for (const entryText of [
      '- packages/core/ferrets/manifest.ts: new restart route',
      '- `packages/core/ferrets/manifest.ts`: new restart route',
      '* `packages/core/ferrets/manifest.ts` - new restart route',
      '1. packages/core/ferrets/manifest.ts — new restart route',
    ]) {
      const result = check(
        { 'packages/core/ferrets/manifest.ts': edit(['a'], ['b']) },
        body('## Contract change', entryText),
      );
      expect(result.ok).toBe(true);
      expect(result.explained).toEqual(['packages/core/ferrets/manifest.ts']);
    }
  });

  test('an entry with no reason, a glob, or another file does not count', () => {
    const changes = { 'packages/core/ferrets/manifest.ts': edit(['a'], ['b']) };
    for (const text of [
      body('## Contract change', '- packages/core/ferrets/manifest.ts'),
      body('## Contract change', '- packages/core/ferrets/*.ts: every seam'),
      body('## Contract change', '- packages/core/ferrets/: the folder'),
      body('## Contract change', '- packages/core/ferrets/daemon/index.ts: another file'),
      body('## Outside files', '- packages/core/ferrets/manifest.ts: wrong section'),
      body('## Contract change and more', '- packages/core/ferrets/manifest.ts: wrong heading'),
    ]) {
      const result = check(changes, text);
      expect(result.ok).toBe(false);
      expect(result.missing.map(item => item.file)).toEqual(['packages/core/ferrets/manifest.ts']);
    }
    expect(
      check(changes, body('## Contract change', '- packages/core/ferrets/manifest.ts')).badEntries.join(),
    ).toContain('has no reason');
  });

  test('every edited composition file needs its own line: one explained does not cover another', () => {
    const result = check(
      {
        'packages/core/ferrets/manifest.ts': edit(['a'], ['b']),
        'packages/core/ferrets/ports-pending.json': edit(['c'], ['d']),
      },
      body('## Contract change', '- packages/core/ferrets/manifest.ts: new route'),
    );
    expect(result.ok).toBe(false);
    expect(result.missing.map(item => item.file)).toEqual(['packages/core/ferrets/ports-pending.json']);
  });

  test('deleting a declared file is an edit of it', () => {
    const result = check({ 'packages/core/ferrets/manifest.ts': edit([], ['gone'], 0, undefined) });
    expect(result.ok).toBe(false);
  });

  test('a problem reading the declarations fails, whatever the body says', () => {
    const result = evaluate({ declared: DECLARED, changes: new Map(), body: '', problems: ['could not read'] });
    expect(result.ok).toBe(false);
    expect(describe(result).join('\n')).toContain('❌ could not read');
  });
});

suite('exempt: one added line in its sorted place', () => {
  const registry = 'packages/core/ferrets/daemon/harness/parts/index.ts';
  const head = ['export default [', '  alpha,', '  bravo,', '  delta,', '] as const;'];

  test('a single added line between its neighbours passes without a section', () => {
    const result = check({
      [registry]: edit(['  charlie,'], [], 4, [...head.slice(0, 3), '  charlie,', ...head.slice(3)]),
    });
    expect(result.ok).toBe(true);
    expect(result.exempt).toEqual([{ file: registry, why: 'registry-add' }]);
  });

  test('the first and the last entry are in sorted place too (the opener and closer are not entries)', () => {
    expect(
      isSortedAdd(registry, edit(['  aaa,'], [], 2, ['export default [', '  aaa,', '  alpha,', '] as const;'])),
    ).toBe(true);
    expect(
      isSortedAdd(
        registry,
        edit(['  zulu,'], [], 4, ['export default [', '  alpha,', '  bravo,', '  zulu,', '] as const;']),
      ),
    ).toBe(true);
  });

  test('a line out of order, a duplicate, an add plus a removal, or two adds are not exempt', () => {
    const lines = ['export default [', '  alpha,', '  bravo,', '  delta,', '] as const;'];
    expect(
      isSortedAdd(
        registry,
        edit(['  zulu,'], [], 3, ['export default [', '  alpha,', '  zulu,', '  bravo,', '  delta,', '] as const;']),
      ),
    ).toBe(false);
    expect(
      isSortedAdd(
        registry,
        edit(['  bravo,'], [], 3, ['export default [', '  alpha,', '  bravo,', '  bravo,', '  delta,', '] as const;']),
      ),
    ).toBe(false);
    expect(isSortedAdd(registry, edit(['  charlie,'], ['  delta,'], 4, lines))).toBe(false);
    expect(isSortedAdd(registry, edit(['  b2,', '  b3,'], [], 3, lines))).toBe(false);
    expect(isSortedAdd(registry, edit(['  charlie,'], [], 4, undefined))).toBe(false);
    // The added line must be the line at `addedAt` in the head (a stale hunk is not trusted).
    expect(isSortedAdd(registry, edit(['  charlie,'], [], 2, lines))).toBe(false);
  });

  test('a composition file (not a registry) is never exempt for an added line', () => {
    const result = check({ 'packages/core/ferrets/manifest.ts': edit(['  a,'], [], 1, ['  a,']) });
    expect(result.ok).toBe(false);
  });

  test('a composition.tsv that only gains declarations is exempt; losing or rewriting one is not', () => {
    const file = 'packages/plugins/board/composition.tsv';
    const head = [
      COMPOSITION_HEADER,
      'composition\tdaemon/host.ts\t-\t-\twiring',
      'composition\tmanifest.ts\t-\t-\tmanifest',
    ];
    const added = 'composition\tdaemon/index.ts\t-\t-\tshell';
    const sorted = [head[0] as string, head[1] as string, added, head[2] as string];
    expect(check({ [file]: edit([added], [], 3, sorted) }).ok).toBe(true);
    expect(check({ [file]: edit([], ['composition\tgone.ts\t-\t-\tx'], 0, head) }).ok).toBe(false);
    // Rewriting a declaration (a removed line and an added one) is an edit of the contract, not an addition.
    expect(check({ [file]: edit([added], ['composition\tmanifest.ts\t-\t-\tmanifest'], 3, sorted) }).ok).toBe(false);
    // A whole new file (a new package declaring itself) is only additions.
    expect(check({ [file]: edit([added, added], [], 2, sorted) }).ok).toBe(true);
    // Adding the first entry sorts after the header, whatever its kind spells.
    expect(
      isSortedAdd(
        file,
        edit(['composition\ta.ts\t-\t-\tfirst'], [], 2, [COMPOSITION_HEADER, 'composition\ta.ts\t-\t-\tfirst']),
      ),
    ).toBe(true);
  });
});

suite('exempt: closing lines of a ports-pending.json ledger', () => {
  const ledger = 'packages/core/ferrets/ports-pending.json';

  test('only deletions pass without a section', () => {
    const result = check({ [ledger]: edit([], ['    "[a] one",', '    "[b] two",']) });
    expect(result.ok).toBe(true);
    expect(result.exempt).toEqual([{ file: ledger, why: 'ledger-closing' }]);
  });

  test('deleting the last entry also rewrites the comma of the new last one, and still passes', () => {
    expect(isLedgerClosing(edit(['    "[a] one"'], ['    "[a] one",', '    "[b] two"']))).toBe(true);
  });

  test('adding a line, or rewriting a line, does not', () => {
    expect(isLedgerClosing(edit(['    "[new] gap",'], []))).toBe(false);
    expect(isLedgerClosing(edit(['    "[a] reworded",'], ['    "[a] one",']))).toBe(false);
    expect(isLedgerClosing(edit(['    "[new] gap",'], ['    "[a] one",', '    "[b] two",']))).toBe(false);
    expect(check({ [ledger]: edit(['    "[new] gap",'], []) }).ok).toBe(false);
  });
});

// ─── the diff reader ─────────────────────────────────────────────────────────────────────────────────────────────

suite('parseDiff', () => {
  test('reads the added and removed lines, and where the first added line is in the head', () => {
    const parsed = parseDiff(
      [
        'diff --git a/x/index.ts b/x/index.ts',
        'index 111..222 100644',
        '--- a/x/index.ts',
        '+++ b/x/index.ts',
        '@@ -3,0 +4 @@ context',
        '+  charlie,',
        '@@ -9 +10,0 @@',
        '-  zulu,',
        'diff --git a/y.json b/y.json',
        'deleted file mode 100644',
        '--- a/y.json',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-{',
        '-}',
      ].join('\n'),
    );
    expect(parsed.get('x/index.ts')).toEqual({
      added: ['  charlie,'],
      removed: ['  zulu,'],
      addedAt: 4,
      deleted: false,
    });
    expect(parsed.get('y.json')).toEqual({ added: [], removed: ['{', '}'], addedAt: 0, deleted: true });
  });

  test('`---` and `+++` are file headers only before the first hunk; inside a hunk they are content', () => {
    const parsed = parseDiff(
      [
        'diff --git a/x/index.ts b/x/index.ts',
        '--- a/x/index.ts',
        '+++ b/x/index.ts',
        '@@ -3,0 +4,2 @@',
        '+  charlie,',
        '+++x;',
        '@@ -9 +11,0 @@',
        '----gone',
        'diff --git a/y.ts b/y.ts',
        '--- a/y.ts',
        '+++ b/y.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ].join('\n'),
    );
    expect(parsed.get('x/index.ts')).toEqual({
      added: ['  charlie,', '++x;'],
      removed: ['---gone'],
      addedAt: 4,
      deleted: false,
    });
    // The next file's headers are headers again.
    expect(parsed.get('y.ts')).toEqual({ added: ['b'], removed: ['a'], addedAt: 1, deleted: false });
  });
});

// ─── composition.tsv: the one reader ─────────────────────────────────────────────────────────────────────────────

suite('composition.tsv', () => {
  const line = (...cells: string[]): string => cells.join('\t');
  const file = (...rows: string[]): string => `${[COMPOSITION_HEADER, ...rows].join('\n')}\n`;

  test('a well formed file parses into repo-relative entries', () => {
    const parsed = parseComposition(
      'packages/plugins/board',
      file(
        line('composition', 'daemon/index.ts', '-', '-', 'wiring shell'),
        line('oversize', 'daemon/lib/big.ts', '2700', '2026-11-30', 'being sliced'),
        line('registry', 'daemon/parts/index.ts', '-', '-', 'one line per part'),
      ),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map(item => [item.kind, item.path])).toEqual([
      ['composition', 'packages/plugins/board/daemon/index.ts'],
      ['oversize', 'packages/plugins/board/daemon/lib/big.ts'],
      ['registry', 'packages/plugins/board/daemon/parts/index.ts'],
    ]);
  });

  test('says what is wrong: header, columns, kind, path, columns of the wrong kind, order, duplicates, reason', () => {
    const bad = parseComposition(
      'pkg',
      [
        'kind\tpath',
        line('composition', 'b.ts', '-', '-', 'ok reason'),
        line('composition', 'a.ts', '-', '-', 'out of order'),
        line('composition', 'a.ts', '-', '-', 'duplicate'),
        line('composition', '../x.ts', '-', '-', 'escapes'),
        line('composition', '/abs.ts', '-', '-', 'absolute'),
        line('composition', 'c.ts', '10', '-', 'a limit on a composition'),
        line('oversize', 'd.ts', 'big', 'soon', 'bad limit and date'),
        line('mystery', 'e.ts', '-', '-', 'unknown kind'),
        line('composition', 'f.ts'),
        line('composition', 'g.ts', '-', '-', ''),
        '',
      ].join('\n'),
    );
    const text = bad.problems.map(problem => `${problem.where} ${problem.message}`).join('\n');
    for (const expected of [
      'composition.tsv:1',
      'is out of order',
      'is declared twice',
      'is not a clean path',
      'takes "-"',
      'needs a line limit',
      'needs a YYYY-MM-DD',
      'unknown kind "mystery"',
      'expected 5 tab-separated columns',
      'has no reason',
    ])
      expect(text).toContain(expected);
  });

  test('readDeclared reads each package, and a path two packages declare is a problem', () => {
    const files: Record<string, string> = {
      'packages/a/composition.tsv': file(line('composition', 'x.ts', '-', '-', 'a seam')),
      'packages/b/composition.tsv': file(line('composition', 'y.ts', '-', '-', 'a seam')),
      'composition.tsv': file(line('composition', 'packages/a/x.ts', '-', '-', 'wrong owner')),
    };
    const declared = readDeclared(['packages/a', 'packages/b', 'packages/c'], path => files[path]);
    expect(declared.entries.map(item => item.path).sort()).toEqual([
      'packages/a/x.ts',
      'packages/a/x.ts',
      'packages/b/y.ts',
    ]);
    expect(declared.problems.map(problem => problem.message).join()).toContain('already declared');
    const problems = checkPaths(declared, ['packages/a', 'packages/b'], path => path !== 'packages/b/y.ts');
    const text = problems.map(problem => problem.message).join('\n');
    expect(text).toContain('"packages/b/y.ts" does not exist');
    expect(text).toContain("declare it in that package's composition.tsv");
  });

  test('one path may carry two kinds (a seam that is also oversize), never the same kind twice', () => {
    const both = file(
      line('composition', 'host.ts', '-', '-', 'a seam'),
      line('oversize', 'host.ts', '700', '2026-11-30', 'wiring, being split'),
    );
    const read = (text: string) =>
      readDeclared(['packages/a'], path => (path === 'packages/a/composition.tsv' ? text : undefined));
    const declared = read(both);
    expect(declared.problems).toEqual([]);
    expect(declared.entries.map(item => item.kind)).toEqual(['composition', 'oversize']);
    // The guard watches the seam half only; the size check reads the oversize half.
    expect([...guarded(declared.entries).values()].map(item => item.kind)).toEqual(['composition']);
    const twice = read(
      file(
        line('oversize', 'host.ts', '700', '2026-11-30', 'wiring, being split'),
        line('oversize', 'host.ts', '800', '2026-12-30', 'again'),
      ),
    );
    expect(twice.problems.map(problem => problem.message).join()).toContain('already declared as oversize');
  });

  test('a path is a composition or a registry, never both; oversize may sit beside either', () => {
    const read = (text: string) =>
      readDeclared(['packages/a'], path => (path === 'packages/a/composition.tsv' ? text : undefined));
    const mixed = read(
      file(line('composition', 'host.ts', '-', '-', 'a seam'), line('registry', 'host.ts', '-', '-', 'a list')),
    );
    expect(mixed.problems.map(problem => problem.message).join()).toContain('declared as both composition');
    expect(mixed.problems[0]?.where).toBe('packages/a/composition.tsv:3');
    // The guard job prints readDeclared problems, so a PR adding the registry row is refused there too.
    expect(checkPaths(mixed, ['packages/a'], () => true).length).toBeGreaterThan(0);
    // Whatever the order, a protected seam keeps its composition kind.
    const rows = mixed.entries;
    expect([...guarded(rows).values()].map(item => item.kind)).toEqual(['composition']);
    expect([...guarded([...rows].reverse()).values()].map(item => item.kind)).toEqual(['composition']);

    const seamBig = read(
      file(
        line('composition', 'host.ts', '-', '-', 'a seam'),
        line('oversize', 'host.ts', '700', '2026-11-30', 'wiring, being split'),
      ),
    );
    expect(seamBig.problems).toEqual([]);
    expect([...guarded(seamBig.entries).values()].map(item => item.kind)).toEqual(['composition']);

    const listBig = read(
      file(
        line('oversize', 'host.ts', '700', '2026-11-30', 'a long list'),
        line('registry', 'host.ts', '-', '-', 'a list'),
      ),
    );
    expect(listBig.problems).toEqual([]);
    expect([...guarded(listBig.entries).values()].map(item => item.kind)).toEqual(['registry']);
  });

  test('an oversize expiry more than 45 days after today is a problem; 45 days exactly is fine', () => {
    const oversizeRow = (expires: string) =>
      readDeclared(['packages/a'], path =>
        path === 'packages/a/composition.tsv'
          ? file(line('oversize', 'host.ts', '700', expires, 'wiring, being split'))
          : undefined,
      );
    const check = (expires: string) => checkPaths(oversizeRow(expires), ['packages/a'], () => true, '2026-11-16');
    expect(check('2026-12-31')).toEqual([]);
    expect(check('2026-11-30')).toEqual([]);
    const far = check('2999-01-01');
    expect(far.map(problem => problem.message).join()).toContain('more than 45 days after 2026-11-16');
    expect(far[0]?.where).toBe('packages/a/composition.tsv:2');
    expect(check('2027-01-01')).toHaveLength(1);
    // Composition and registry rows carry no expiry and are never judged by it.
    expect(
      checkPaths(
        readDeclared(['packages/a'], () => file(line('composition', 'host.ts', '-', '-', 'a seam'))),
        ['packages/a'],
        () => true,
        '2026-11-16',
      ),
    ).toEqual([]);
  });

  test('two independent declarations added in the same gap merge cleanly under the repository .gitattributes', () => {
    const attributes = readFileSync(join(import.meta.dir, '..', '..', '.gitattributes'), 'utf8')
      .split('\n')
      .filter(row => !row.startsWith('#') && /\bcomposition\.tsv merge=union$/.test(row))
      .join('\n');
    expect(attributes).not.toBe('');
    const path = 'packages/plugins/board/composition.tsv';
    const rows = (...paths: string[]): string =>
      file(...paths.map(name => line('composition', name, '-', '-', `reason ${name}`)));
    const spec = {
      base: { [path]: rows('a.ts', 'd.ts') },
      // Both land between a.ts and d.ts: the same gap, the case a plain merge cannot take.
      a: { [path]: rows('a.ts', 'b.ts', 'd.ts') },
      b: { [path]: rows('a.ts', 'c.ts', 'd.ts') },
    };
    const plain = runTwoAdds({ ...spec, both: { [path]: rows('a.ts', 'b.ts', 'c.ts', 'd.ts') } });
    expect([plain.mergeAB.ok, plain.mergeBA.ok, plain.rebase.ok]).toEqual([false, false, false]);
    const unioned = runTwoAdds({ ...spec, both: { [path]: rows('a.ts', 'b.ts', 'c.ts', 'd.ts') }, attributes });
    for (const result of [unioned.mergeAB, unioned.mergeBA, unioned.rebase]) {
      expect(result.ok).toBe(true);
      const merged = result.files[path] ?? '';
      expect(merged.split('\n')[0]).toBe(COMPOSITION_HEADER);
      expect(merged).toContain('b.ts');
      expect(merged).toContain('c.ts');
      expect(
        parseComposition('packages/plugins/board', merged)
          .entries.map(item => item.path.split('/').pop())
          .sort(),
      ).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    }
  });
});

// ─── end to end in a throw-away git repository ───────────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const ENV = {
  PATH: process.env.PATH ?? '',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'composition-guard-'));
  dirs.push(dir);
  const git = (...args: string[]): string => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: dir,
      env: ENV,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string): string => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, write, commit };
}

const PARTS = ['export default [', '  alpha,', '  bravo,', '  delta,', '] as const;', ''].join('\n');
const TSV = `${[
  COMPOSITION_HEADER,
  ['composition', 'manifest.ts', '-', '-', 'the manifest literal'].join('\t'),
  ['registry', 'parts/index.ts', '-', '-', 'one line per part'].join('\t'),
  ['composition', 'ports-pending.json', '-', '-', 'the ledger'].join('\t'),
].join('\n')}\n`;

/** A repository with one package that declares a seam, a ledger and a registry; returns the base commit. */
function fixture() {
  const r = repo();
  r.git('init', '-q', '-b', 'base');
  r.write('package.json', JSON.stringify({ name: 'x', workspaces: ['packages/*'] }));
  r.write('packages/alpha/package.json', '{"name":"alpha"}');
  r.write('packages/alpha/manifest.ts', 'export const manifest = { id: 1 };\n');
  r.write('packages/alpha/ports-pending.json', '{\n  "pending": [\n    "[a] one",\n    "[b] two"\n  ]\n}\n');
  r.write('packages/alpha/parts/index.ts', PARTS);
  r.write('packages/alpha/composition.tsv', TSV);
  r.write('packages/alpha/other.ts', 'export const other = 1;\n');
  const base = r.commit('base');
  r.git('checkout', '-q', '-b', 'pr');
  return { ...r, base };
}

const guard = (f: ReturnType<typeof fixture>, prBody: string) => {
  const head = f.git('rev-parse', 'HEAD');
  return run(f.dir, {
    FY_ONE_FOLDER_EVENT: 'pull_request',
    FY_ONE_FOLDER_BASE_REF: 'rebuild/5.0-after',
    FY_ONE_FOLDER_BASE_SHA: f.base,
    FY_ONE_FOLDER_HEAD_SHA: head,
    FY_ONE_FOLDER_PR_BODY: prBody,
  });
};

suite('the job, end to end (real git, no network)', () => {
  test('the fixture declarations are valid', () => {
    expect(parseComposition('packages/alpha', TSV).problems).toEqual([]);
  });

  test('passes when the PR edits no composition file', () => {
    const f = fixture();
    f.write('packages/alpha/other.ts', 'export const other = 2;\n');
    f.write('packages/alpha/new-feature.ts', 'export {};\n');
    f.commit('feat: a feature in its own file');
    const result = guard(f, '');
    expect(result.code).toBe(0);
    expect(result.lines.join('\n')).toContain('No composition file is edited');
  });

  test('fails on an edit of a declared file without the section; passes with it', () => {
    const f = fixture();
    f.write('packages/alpha/manifest.ts', 'export const manifest = { id: 2, extra: true };\n');
    f.commit('feat: edit the manifest');
    const failed = guard(f, 'Home: alpha');
    expect(failed.code).toBe(1);
    expect(failed.lines.join('\n')).toContain('✗ packages/alpha/manifest.ts');
    const passed = guard(
      f,
      body('## Contract change', '- packages/alpha/manifest.ts: a new field every consumer reads'),
    );
    expect(passed.code).toBe(0);
  });

  test('a PR cannot un-declare a file and edit it in the same change: declarations are read at the merge-base', () => {
    const f = fixture();
    f.write('packages/alpha/manifest.ts', 'export const manifest = { id: 3 };\n');
    f.write('packages/alpha/composition.tsv', `${COMPOSITION_HEADER}\n`);
    f.commit('feat: quietly un-declare and edit');
    const result = guard(f, '');
    expect(result.code).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain('✗ packages/alpha/manifest.ts');
    expect(text).toContain('✗ packages/alpha/composition.tsv');
  });

  test('a registry that gains one line in its sorted place passes without a section; two lines, or an unsorted one, fail', () => {
    const one = fixture();
    one.write('packages/alpha/parts/index.ts', PARTS.replace('  delta,', '  charlie,\n  delta,'));
    one.commit('feat: add a part');
    expect(guard(one, '').code).toBe(0);

    const two = fixture();
    two.write('packages/alpha/parts/index.ts', PARTS.replace('  delta,', '  charlie,\n  delta,\n  echo,'));
    two.commit('feat: add two parts');
    expect(guard(two, '').code).toBe(1);

    // A sorted add plus an unindented `++x;` line is two added lines (`+++x;` in the diff, not a file header): RED.
    const smuggled = fixture();
    smuggled.write('packages/alpha/parts/index.ts', PARTS.replace('  delta,', '  charlie,\n  delta,\n++x;'));
    smuggled.commit('feat: add a part and a line that looks like a diff header');
    expect(guard(smuggled, '').code).toBe(1);

    const unsorted = fixture();
    unsorted.write('packages/alpha/parts/index.ts', PARTS.replace('  alpha,', '  alpha,\n  zulu,'));
    unsorted.commit('feat: add a part out of order');
    const result = guard(unsorted, '');
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('✗ packages/alpha/parts/index.ts');
  });

  test('a ledger PR that only deletes lines passes; one that adds a line does not', () => {
    const closing = fixture();
    closing.write('packages/alpha/ports-pending.json', '{\n  "pending": [\n    "[a] one"\n  ]\n}\n');
    closing.commit('fix: close a ruled line');
    expect(guard(closing, '').code).toBe(0);

    const adding = fixture();
    adding.write(
      'packages/alpha/ports-pending.json',
      '{\n  "pending": [\n    "[a] one",\n    "[b] two",\n    "[c] three"\n  ]\n}\n',
    );
    adding.commit('feat: a new gap');
    expect(guard(adding, '').code).toBe(1);
  });

  test('a package declaring one more file (one sorted line in its composition.tsv) passes', () => {
    const f = fixture();
    f.write('packages/alpha/other.ts', 'export const other = 1;\n');
    f.write('packages/alpha/composition.tsv', `${TSV}${['composition', 'zz.ts', '-', '-', 'a new seam'].join('\t')}\n`);
    f.write('packages/alpha/zz.ts', 'export {};\n');
    f.commit('feat: declare a seam');
    expect(guard(f, '').code).toBe(0);
  });

  test('a new package declaring itself (a whole new composition.tsv) passes', () => {
    const f = fixture();
    f.write('packages/beta/package.json', '{"name":"beta"}');
    f.write('packages/beta/manifest.ts', 'export const manifest = {};\n');
    f.write(
      'packages/beta/composition.tsv',
      `${COMPOSITION_HEADER}\n${['composition', 'manifest.ts', '-', '-', 'the manifest'].join('\t')}\n`,
    );
    f.commit('feat: a new package');
    expect(guard(f, '').code).toBe(0);
  });

  test("another base, or no event, is not this rule's to check; an unknown sha fails and says why", () => {
    const f = fixture();
    const elsewhere = run(f.dir, { FY_ONE_FOLDER_EVENT: 'pull_request', FY_ONE_FOLDER_BASE_REF: 'main' });
    expect(elsewhere.code).toBe(0);
    const unknown = run(f.dir, {
      FY_ONE_FOLDER_EVENT: 'pull_request',
      FY_ONE_FOLDER_BASE_REF: 'rebuild/5.0-after',
      FY_ONE_FOLDER_BASE_SHA: 'deadbeefdeadbeef',
      FY_ONE_FOLDER_HEAD_SHA: 'deadbeefdeadbeef',
    });
    expect(unknown.code).toBe(1);
    expect(unknown.lines.join('\n')).toContain('no merge-base');
  });
});

// ─── the repository's own declarations (read from the working tree) ──────────────────────────────────────────────────

const REPO = join(import.meta.dir, '..', '..');
const readRepo = (path: string): string | undefined => {
  try {
    return readFileSync(join(REPO, path), 'utf8');
  } catch {
    return undefined;
  }
};
const real = readDeclared(packageRoots(REPO), readRepo);
const realGuarded = guarded(real.entries);
const PORTS = 'packages/core/kernel/contract/ports.ts';
const PARTS_INDEXES = [
  'packages/plugins/codex/daemon/harness/parts/index.ts',
  'packages/plugins/claude-code/daemon/harness/parts/index.ts',
];
const lines = (path: string): string[] => (readRepo(path) ?? '').split('\n');
/** The head of `path` with `added` inserted before 1-based line `at`: a FileChange that adds exactly those lines. */
const inserting = (path: string, additions: readonly [at: number, line: string][]): FileChange => {
  const head = lines(path);
  let shift = 0;
  for (const [at, text] of additions) {
    head.splice(at - 1 + shift, 0, text);
    shift++;
  }
  return {
    added: additions.map(([, text]) => text),
    removed: [],
    addedAt: (additions[0]?.[0] ?? 1) as number,
    head,
  };
};

suite("the repository's declarations", () => {
  test('every composition.tsv is well formed and names files that exist', () => {
    expect(checkPaths(real, packageRoots(REPO), path => readRepo(path) !== undefined)).toEqual([]);
  });

  test('the root composition.tsv declares the guard itself, so a PR cannot weaken it without a Contract change', () => {
    for (const file of [
      'scripts/ci/composition-guard.ts',
      'scripts/ci/lib/composition.ts',
      '.github/workflows/one-folder.yaml',
    ]) {
      expect(realGuarded.get(file)?.kind).toBe('composition');
      expect(realGuarded.get(file)?.owner).toBe('');
      const result = evaluate({
        declared: realGuarded,
        changes: new Map([[file, edit(['x'], ['y'])]]),
        body: '',
      });
      expect(result.ok).toBe(false);
      expect(result.missing.map(item => item.file)).toEqual([file]);
    }
    // ...and the root composition.tsv itself: removing a declaration is not exempt.
    const root = new Map([['composition.tsv', edit([], ['composition\tscripts/ci/composition-guard.ts\t-\t-\tx'], 0)]]);
    expect(evaluate({ declared: realGuarded, changes: root, body: '' }).ok).toBe(false);
  });

  test('the kernel ports barrel is a registry: one sorted `export *` line is green', () => {
    expect(realGuarded.get(PORTS)?.kind).toBe('registry');
    const head = lines(PORTS);
    const at = head.findIndex(row => row.includes("'./ports/clock.ts'")) + 2;
    const change = inserting(PORTS, [[at, "export * from './ports/clock2.ts';"]]);
    const result = evaluate({ declared: realGuarded, changes: new Map([[PORTS, change]]), body: '' });
    expect(result.ok).toBe(true);
    expect(result.exempt.map(item => item.why)).toEqual(['registry-add']);
    // out of its sorted place: red
    const unsorted = inserting(PORTS, [[at - 3, "export * from './ports/clock2.ts';"]]);
    expect(evaluate({ declared: realGuarded, changes: new Map([[PORTS, unsorted]]), body: '' }).ok).toBe(false);
  });

  test.each(PARTS_INDEXES)(
    'the harness parts registry %s: a new part is ONE sorted line, GREEN with no Contract change; an unsorted one is red',
    path => {
      expect(realGuarded.get(path)?.kind).toBe('registry');
      const head = lines(path);
      const homeAt = head.findIndex(row => row.startsWith("export * as home from './home.ts'")) + 2;
      const green = evaluate({
        declared: realGuarded,
        changes: new Map([[path, inserting(path, [[homeAt, "export * as homeA from './home-a.ts';"]])]]),
        body: '',
      });
      expect(green.ok).toBe(true);
      expect(green.exempt).toEqual([{ file: path, why: 'registry-add' }]);
      // Out of its sorted place (before `deliver`): not a pure registry add, so it needs the section.
      const firstAt = head.findIndex(row => row.startsWith('export * as ')) + 1;
      const unsorted = new Map([[path, inserting(path, [[firstAt, "export * as zzz from './zzz.ts';"]])]]);
      expect(evaluate({ declared: realGuarded, changes: unsorted, body: '' }).ok).toBe(false);
    },
  );
});

suite('a root composition.tsv, end to end (real git, no network)', () => {
  const ROOT_TSV = `${[
    COMPOSITION_HEADER,
    ['composition', 'scripts/ci/guard.ts', '-', '-', 'the guard itself'].join('\t'),
  ].join('\n')}\n`;
  const rootFixture = () => {
    const r = repo();
    r.git('init', '-q', '-b', 'base');
    r.write('package.json', JSON.stringify({ name: 'x', workspaces: ['packages/*'] }));
    r.write('packages/alpha/package.json', '{"name":"alpha"}');
    r.write('composition.tsv', ROOT_TSV);
    r.write('scripts/ci/guard.ts', 'export const guard = 1;\n');
    const base = r.commit('base');
    r.git('checkout', '-q', '-b', 'pr');
    return { ...r, base };
  };

  test('weakening a file the root declares needs a Contract change section', () => {
    const f = rootFixture();
    f.write('scripts/ci/guard.ts', 'export const guard = 0;\n');
    f.commit('feat: weaken the guard');
    const failed = guard(f, '');
    expect(failed.code).toBe(1);
    expect(failed.lines.join('\n')).toContain('✗ scripts/ci/guard.ts  (composition of the repository root)');
    expect(guard(f, body('## Contract change', '- scripts/ci/guard.ts: a reason')).code).toBe(0);
  });

  test('un-declaring it in the same PR does not help: the root file is read at the merge-base', () => {
    const f = rootFixture();
    f.write('scripts/ci/guard.ts', 'export const guard = 0;\n');
    f.write('composition.tsv', `${COMPOSITION_HEADER}\n`);
    f.commit('feat: quietly un-declare and weaken');
    const result = guard(f, '');
    expect(result.code).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain('✗ scripts/ci/guard.ts');
    expect(text).toContain('✗ composition.tsv');
  });
});
