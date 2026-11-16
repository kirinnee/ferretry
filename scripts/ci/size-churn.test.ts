import { afterEach, describe as suite, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { COMPOSITION_HEADER, type CompositionEntry } from './lib/composition.ts';
import {
  CHURN_MERGES,
  CHURN_WINDOW,
  SIZE_LIMIT,
  countLines,
  describe,
  evaluate,
  isSource,
  parseWindow,
  replay,
  run,
} from './size-churn.ts';

const TODAY = '2026-11-20';
const BIG = 'packages/plugins/board/daemon/service.ts';
const HOT = 'packages/plugins/board/daemon/host.ts';

const oversize = (path: string, limit: number, expires: string): CompositionEntry => ({
  kind: 'oversize',
  path,
  owner: 'packages/plugins/board',
  limit: String(limit),
  expires,
  reason: 'being split',
  line: 2,
});
const registry = (path: string): CompositionEntry => ({
  kind: 'registry',
  path,
  owner: 'packages/plugins/board',
  limit: '-',
  expires: '-',
  reason: 'a sorted list',
  line: 3,
});

const check = (
  changed: string[],
  sizes: Record<string, number>,
  churn: Record<string, number> = {},
  declared: CompositionEntry[] = [],
) =>
  evaluate({
    changed,
    lines: file => sizes[file],
    churn: new Map(Object.entries(churn)),
    declared,
    today: TODAY,
  });

// ─── the rule, pure ──────────────────────────────────────────────────────────────────────────────────────────────

suite('size', () => {
  test('a changed source file over the limit is RED and names the file, its size and the way out', () => {
    const result = check([BIG], { [BIG]: SIZE_LIMIT + 1 });
    expect(result.ok).toBe(false);
    expect(result.findings.map(item => [item.file, item.rule])).toEqual([[BIG, 'size']]);
    const text = describe(result, undefined).join('\n');
    expect(text).toContain(`${BIG} has ${SIZE_LIMIT + 1} lines`);
    expect(text).toContain('oversize');
  });

  test('exactly the limit is GREEN; under it is GREEN', () => {
    expect(check([BIG], { [BIG]: SIZE_LIMIT }).ok).toBe(true);
    expect(check([BIG], { [BIG]: 10 }).ok).toBe(true);
  });

  test('a declared file is GREEN up to its limit, until its date (the date itself is still live)', () => {
    const declared = [oversize(BIG, 2000, TODAY)];
    const result = check([BIG], { [BIG]: 2000 }, {}, declared);
    expect(result.ok).toBe(true);
    expect(result.allowed).toEqual([{ file: BIG, limit: 2000, expires: TODAY }]);
    expect(describe(result, undefined).join('\n')).toContain('declared oversize (up to 2000 lines');
  });

  test('a declared file that GREW past its limit is RED (the declaration is a ceiling, not a licence)', () => {
    const result = check([BIG], { [BIG]: 2001 }, {}, [oversize(BIG, 2000, '2026-12-16')]);
    expect(result.ok).toBe(false);
    expect(result.findings.map(item => item.rule)).toEqual(['ceiling']);
    expect(result.findings[0]?.message).toContain('may not grow');
  });

  test('an EXPIRED declaration is RED even when the file is small or has not grown', () => {
    const result = check([BIG], { [BIG]: 1600 }, {}, [oversize(BIG, 2000, '2026-11-19')]);
    expect(result.ok).toBe(false);
    expect(result.findings.map(item => item.rule)).toEqual(['expired']);
    expect(result.findings[0]?.message).toContain('expired on 2026-11-19');
    expect(check([BIG], { [BIG]: 5 }, {}, [oversize(BIG, 2000, '2026-11-19')]).ok).toBe(false);
  });

  test('only a file the PR changes is judged: a big file nobody touched is not this PR to fix', () => {
    const result = check(['packages/plugins/board/daemon/small.ts'], {
      [BIG]: 9999,
      'packages/plugins/board/daemon/small.ts': 20,
    });
    expect(result.ok).toBe(true);
    expect(result.judged).toEqual(['packages/plugins/board/daemon/small.ts']);
  });

  test('a deleted file (no lines) is not judged', () => {
    expect(check([BIG], {}).ok).toBe(true);
  });
});

suite('churn', () => {
  test(`edited by ${CHURN_MERGES} of the last ${CHURN_WINDOW} merges is RED; one fewer is GREEN`, () => {
    const hot = check([HOT], { [HOT]: 300 }, { [HOT]: CHURN_MERGES });
    expect(hot.ok).toBe(false);
    expect(hot.findings.map(item => item.rule)).toEqual(['churn']);
    expect(hot.findings[0]?.message).toContain(`edited by ${CHURN_MERGES} of the last ${CHURN_WINDOW} merges`);
    expect(check([HOT], { [HOT]: 300 }, { [HOT]: CHURN_MERGES - 1 }).ok).toBe(true);
  });

  test('a declared hot file is GREEN, until it expires', () => {
    const live = check([HOT], { [HOT]: 300 }, { [HOT]: 11 }, [oversize(HOT, 330, '2026-11-30')]);
    expect(live.ok).toBe(true);
    expect(live.allowed.map(item => item.file)).toEqual([HOT]);
    const dead = check([HOT], { [HOT]: 300 }, { [HOT]: 11 }, [oversize(HOT, 330, '2026-11-01')]);
    expect(dead.findings.map(item => item.rule)).toEqual(['expired']);
  });

  test('a file in a registry entry is exempt from churn (one sorted line per PR is the design) but not from size', () => {
    expect(check([HOT], { [HOT]: 300 }, { [HOT]: 40 }, [registry(HOT)]).ok).toBe(true);
    expect(check([HOT], { [HOT]: 1800 }, { [HOT]: 40 }, [registry(HOT)]).findings.map(item => item.rule)).toEqual([
      'size',
    ]);
  });

  test('a file that is both over the size limit and hot gets both findings', () => {
    const result = check([BIG], { [BIG]: 2000 }, { [BIG]: 9 });
    expect(result.findings.map(item => item.rule)).toEqual(['size', 'churn']);
  });
});

suite('what is a source file', () => {
  test.each([
    ['packages/a/daemon/index.ts', true],
    ['packages/a/app/page.tsx', true],
    ['scripts/ci/size-churn.ts', true],
    ['packages/a/tests/unit/x.ts', false],
    ['packages/a/testing/host.ts', false],
    ['packages/a/contract/testing/index.ts', false],
    ['scripts/ci/size-churn.test.ts', false],
    ['packages/a/daemon/generated/features.ts', false],
    ['generated/hooks.ts', false],
    ['packages/a/tests/fixtures/big.ts', false],
    ['packages/a/types.d.ts', false],
    ['migration/some-tool/src/big.ts', false],
    ['composition.tsv', false],
    ['docs/standards/x.md', false],
    ['packages/core/ferrets/ports-pending.json', false],
  ])('%s -> %p', (file, expected) => {
    expect(isSource(file)).toBe(expected);
  });

  test('a test, a generated file and a ledger are never judged, however big or hot', () => {
    const files = [
      'packages/a/tests/unit/x.test.ts',
      'packages/a/daemon/generated/f.ts',
      'packages/a/ports-pending.json',
    ];
    const result = check(
      files,
      Object.fromEntries(files.map(file => [file, 99999])),
      Object.fromEntries(files.map(file => [file, 99])),
    );
    expect(result.ok).toBe(true);
    expect(result.judged).toEqual([]);
  });
});

test('countLines counts lines, with or without a final newline', () => {
  expect(countLines('')).toBe(0);
  expect(countLines('a')).toBe(1);
  expect(countLines('a\n')).toBe(1);
  expect(countLines('a\nb\n')).toBe(2);
  expect(countLines('a\n\nb')).toBe(3);
});

suite('the churn window parses git log', () => {
  const log = [
    '\u0001aaa pa pb\nx.ts\ny.ts\n\n',
    '\u0001bbb pc pd\nx.ts\n\n',
    '\u0001ccc pe\nx.ts\nx.ts\n\n',
    '\u0001ddd \nx.ts\ny.ts\nz.ts\n\n',
  ].join('');

  test('counts merges per file, once per merge, and skips the parentless boundary commit', () => {
    const window = parseWindow(log);
    expect(window.merges).toBe(3);
    expect(window.counts.get('x.ts')).toBe(3);
    expect(window.counts.get('y.ts')).toBe(1);
    expect(window.counts.has('z.ts')).toBe(false);
  });

  test('an empty log is an empty window, not an error', () => {
    expect(parseWindow('')).toEqual({ merges: 0, counts: new Map() });
  });

  test('says when it could read fewer merges than the window', () => {
    const result = check([BIG], { [BIG]: 5 });
    expect(describe(result, { merges: 12, counts: new Map() }).join('\n')).toContain('only 12 merges');
    expect(describe(result, { merges: CHURN_WINDOW, counts: new Map() }).join('\n')).not.toContain('only');
  });
});

// ─── run(): the real git read ────────────────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};

const put = (root: string, file: string, text: string): void => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

const HOT_FILE = 'packages/plugins/board/daemon/host.ts';
const declaration = (limit: number, expires: string): string =>
  `${COMPOSITION_HEADER}\ncomposition\tdaemon/host.ts\t-\t-\ta seam\noversize\tdaemon/host.ts\t${limit}\t${expires}\tbeing split\n`;

/** A base with `merges` separate PRs (--no-ff merges) that each edited the hot file, and a feature branch off it. */
const repo = (merges: number): string => {
  const root = mkdtempSync(join(tmpdir(), 'size-churn-'));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  put(root, 'package.json', JSON.stringify({ name: 'r', workspaces: ['packages/*', 'packages/plugins/*'] }));
  put(root, 'packages/plugins/board/package.json', '{"name":"@ferretry/plugin-board"}');
  put(root, HOT_FILE, 'export const a = 0;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  for (let index = 1; index <= merges; index++) {
    git(root, 'checkout', '-q', '-b', `pr${index}`);
    put(root, HOT_FILE, `export const a = ${index};\n`);
    // a PR that edits the file in two commits is still ONE merge
    git(root, 'commit', '-qam', `pr ${index} first`);
    put(root, HOT_FILE, `export const a = ${index};\nexport const b = ${index};\n`);
    git(root, 'commit', '-qam', `pr ${index} second`);
    git(root, 'checkout', '-q', 'main');
    git(root, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${index}`, `pr${index}`);
  }
  git(root, 'checkout', '-q', '-b', 'feature');
  return root;
};

const env = (root: string) => ({
  FY_ONE_FOLDER_EVENT: 'pull_request',
  FY_ONE_FOLDER_BASE_REF: 'rebuild/5.0-after',
  FY_ONE_FOLDER_BASE_SHA: git(root, 'rev-parse', 'main'),
  FY_ONE_FOLDER_HEAD_SHA: git(root, 'rev-parse', 'HEAD'),
});

const editHot = (root: string, extra?: (root: string) => void): void => {
  put(root, HOT_FILE, 'export const a = 999;\n');
  extra?.(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feature');
};

suite('run: git, a window of real merges and a declaration in the PR', () => {
  test(`a file edited by ${CHURN_MERGES} separate PRs is RED for the next PR that edits it`, () => {
    const root = repo(CHURN_MERGES);
    editHot(root);
    const result = run(root, env(root));
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain(
      `${HOT_FILE} was edited by ${CHURN_MERGES} of the last ${CHURN_WINDOW} merges`,
    );
  });

  test('...and GREEN one merge short of it (two commits in one PR count once)', () => {
    const root = repo(CHURN_MERGES - 1);
    editHot(root);
    expect(run(root, env(root)).code).toBe(0);
  });

  test('a PR that does not edit the hot file is GREEN however hot it is', () => {
    const root = repo(CHURN_MERGES + 2);
    put(root, 'packages/plugins/board/daemon/other.ts', 'export const o = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'feature');
    expect(run(root, env(root)).code).toBe(0);
  });

  test('the PR declaring the file in its own composition.tsv is GREEN; an expired row is RED', () => {
    const live = repo(CHURN_MERGES);
    editHot(live, root => put(root, 'packages/plugins/board/composition.tsv', declaration(50, '2999-01-01')));
    const green = run(live, env(live));
    expect(green.code).toBe(0);
    expect(green.lines.join('\n')).toContain('declared oversize (up to 50 lines, until 2999-01-01)');

    const dead = repo(CHURN_MERGES);
    editHot(dead, root => put(root, 'packages/plugins/board/composition.tsv', declaration(50, '2000-01-01')));
    const red = run(dead, env(dead));
    expect(red.code).toBe(1);
    expect(red.lines.join('\n')).toContain('expired on 2000-01-01');
  });

  test('a file over the size limit is RED; declared with room, GREEN; declared too small, RED', () => {
    const big = 'packages/plugins/board/daemon/big.ts';
    const lines = `${Array.from({ length: SIZE_LIMIT + 10 }, (_, index) => `export const v${index} = ${index};`).join('\n')}\n`;
    const make = (rows?: string) => {
      const root = repo(0);
      put(root, big, lines);
      if (rows !== undefined) put(root, 'packages/plugins/board/composition.tsv', rows);
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'feature');
      return root;
    };
    const row = (limit: number) => `${COMPOSITION_HEADER}\noversize\tdaemon/big.ts\t${limit}\t2999-01-01\tdata\n`;
    const red = make();
    expect(run(red, env(red)).lines.join('\n')).toContain(`big.ts has ${SIZE_LIMIT + 10} lines`);
    expect(run(red, env(red)).code).toBe(1);
    const ok = make(row(SIZE_LIMIT + 10));
    expect(run(ok, env(ok)).code).toBe(0);
    const tight = make(row(SIZE_LIMIT + 9));
    expect(run(tight, env(tight)).lines.join('\n')).toContain('may not grow');
  });

  test('other events and other bases are not checked; a missing sha fails with a reason', () => {
    const root = repo(0);
    expect(run(root, { ...env(root), FY_ONE_FOLDER_EVENT: 'push' }).code).toBe(0);
    expect(run(root, { ...env(root), FY_ONE_FOLDER_BASE_REF: 'main' }).code).toBe(0);
    const noSha = run(root, { ...env(root), FY_ONE_FOLDER_BASE_SHA: '' });
    expect(noSha.code).toBe(1);
    expect(noSha.lines.join('\n')).toContain('could not be computed');
  });

  test('--replay prints, per merge, what the rule would have flagged', () => {
    const root = repo(CHURN_MERGES + 1);
    const table = replay(root, 'main', 3).join('\n');
    expect(table).toContain('Flagged with no declaration');
    // the last merge sees CHURN_MERGES earlier merges of the file, so it is flagged; the rows are newest first
    expect(table).toContain(`#${CHURN_MERGES + 1}`);
    expect(table).toContain('plugins/board/daemon/host.ts` (churn)');
    expect(table).toMatch(/Of 3 merges: \d+ would have been flagged with no declaration/);
  });
});

// ─── the workflow wiring ─────────────────────────────────────────────────────────────────────────────────────────

test('one-folder.yaml runs the check after a deeper fetch of the base, even when an earlier step failed', () => {
  type Step = { name?: string; run?: string; if?: string };
  const workflow = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, '../../.github/workflows/one-folder.yaml'), 'utf8'),
  ) as { jobs: Record<string, { steps: Step[] }> };
  const steps = workflow.jobs['one-folder']?.steps ?? [];
  const fetchAt = steps.findIndex(step => String(step.run ?? '').includes('--depth=2000'));
  const checkAt = steps.findIndex(step => String(step.run ?? '').includes('size-churn.ts'));
  expect(fetchAt).toBeGreaterThan(-1);
  expect(checkAt).toBe(fetchAt + 1);
  expect(steps[checkAt]?.if).toBe('${{ !cancelled() }}');
  // the deeper fetch must not interpolate event data into the script
  expect(String(steps[fetchAt]?.run)).not.toContain('github.event');
});
