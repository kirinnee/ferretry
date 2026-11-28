import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { countLiterals, countTables, PINNED, tablesKey } from './no-harness-literal.ts';

const root = join(import.meta.dir, '../..');
const GATE = 'scripts/validate/no-harness-literal.sh';
const SCANNER = 'scripts/validate/no-harness-literal.ts';
const LEDGER = 'scripts/validate/no-harness-literal-remaining.txt';
const DAEMON = 'packages/plugins/runtimes/daemon';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { force: true, recursive: true });
});

interface Setup {
  /** The list in the working tree. */
  readonly ledger?: string;
  /** The list at the base commit; `null` is a base that predates it (the bootstrap). Default: `null`. */
  readonly base?: string | null;
  /** Name a base that does not exist, so the gate cannot read it. */
  readonly missingBase?: boolean;
}

/** A throwaway git repo holding the gate, a base commit and the planted sources; returns the gate's run. */
const run = (
  files: Record<string, string>,
  setup: Setup = {},
): { status: number | null; stderr: string; stdout: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'fy-harness-literal-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'scripts/validate'), { recursive: true });
  for (const file of [GATE, SCANNER]) copyFileSync(join(root, file), join(dir, file));
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  if (setup.base != null) writeFileSync(join(dir, LEDGER), setup.base);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(dir, LEDGER), setup.ledger ?? '');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git('add', '-A');
  return spawnSync('bash', [join(dir, GATE)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, FY_CHECK_BASE: setup.missingBase ? 'no-such-ref' : baseSha },
  });
};

describe('countLiterals', () => {
  test('counts a string that is exactly a harness word, in either quote style', () => {
    expect(countLiterals(`const a = 'claude'; const b = "codex"; const c = 'codex';`)).toBe(3);
  });

  test('counts a template with no placeholder and not one with a placeholder', () => {
    expect(countLiterals('const a = `claude`; const b = `claude-${x}`;')).toBe(1);
  });

  test('does not count a longer word, a word in a comment, or a property key', () => {
    expect(
      countLiterals(`const a = 'claude-code'; // 'claude'\n/* 'codex' */ const b = { claude: 1, codex: 2 };`),
    ).toBe(0);
  });

  test('counts a literal inside a template interpolation, however deep', () => {
    expect(countLiterals("const a = `kind ${x === 'claude' ? 'codex' : 'other'}`;")).toBe(2);
    expect(countLiterals("const a = `a ${`b ${y('codex')} c`} d`;")).toBe(1);
    expect(countLiterals("const a = `${ { k: 'claude' }.k }`; const b = 'codex';")).toBe(2);
  });

  test('counts a plain template after an interpolation closed, and keeps the template text out of the count', () => {
    expect(countLiterals('const a = `claude ${x} codex`; const b = `codex`;')).toBe(1);
  });

  test('does not read a quote inside a regular expression or a comment as a string', () => {
    expect(countLiterals("const a = /'/u.test(x); const b = 'claude';")).toBe(1);
    expect(countLiterals("const a = x / 2; const b = 'codex'; // 'claude'")).toBe(1);
  });

  test('reads a string to its closing quote, so an escaped quote does not end it early', () => {
    expect(countLiterals(String.raw`const a = 'it\'s claude'; const b = 'codex';`)).toBe(1);
  });
});

describe('a regular expression after a keyword', () => {
  test('is skipped whole, so its quoted word is not a string', () => {
    expect(countLiterals("export function m(input: string) { return /'codex'/.test(input); }")).toBe(0);
    expect(countLiterals("const f = (x: string) => { throw /'claude'/.exec(x) ?? 'codex'; };")).toBe(1);
    expect(countLiterals("switch (k) { case /'claude'/.source: break; } const b = 'codex';")).toBe(1);
  });

  test('a division after a name is still a division', () => {
    expect(countLiterals("const a = total / 2; const b = 'claude'; const c = total / 3;")).toBe(1);
  });
});

describe('countTables', () => {
  test('counts a Record, a Partial/Readonly one, a satisfies, an as and a mapped type keyed by the kind', () => {
    expect(countTables('const a: Record<HarnessKind, number> = { claude: 1, codex: 2 };')).toBe(1);
    expect(countTables('const a: Readonly<Partial<Record<HarnessKind, string>>> = {};')).toBe(1);
    expect(countTables('const a = { claude: 1, codex: 2 } as const satisfies Record<HarnessKind, number>;')).toBe(1);
    expect(countTables('const a = make() as Record<HarnessKind, number>;')).toBe(1);
    expect(countTables('type T = { [Kind in HarnessKind]: Kind };')).toBe(1);
    expect(countTables('const a: Record<HarnessScope, string> = x;')).toBe(1);
  });

  test('counts a table whose key type is split over lines or qualified by an import type', () => {
    expect(countTables('const a = x as Record<\n  HarnessKind,\n  number\n>;')).toBe(1);
    expect(countTables("const a: Record<import('./harness-kind.ts').HarnessKind, number> = x;")).toBe(1);
  });

  test('counts each table of a line, nested ones included', () => {
    expect(
      countTables('type A = Record<HarnessKind, Record<HarnessKind, number>>; type B = Record<HarnessKind, 1>;'),
    ).toBe(3);
  });

  test('does not count a Record whose KEY is another type, a value typed by the kind, or a word in a comment or string', () => {
    expect(countTables('const a: Record<string, HarnessKind> = x;')).toBe(0);
    expect(countTables('const a: Record<PackageManager, { harness: HarnessKind }> = x;')).toBe(0);
    expect(countTables("// Record<HarnessKind, number>\nconst a = 'Record<HarnessKind, number>';")).toBe(0);
    expect(countTables('for (const k in HarnessKind) go(k); const f = (k: HarnessKind) => k;')).toBe(0);
    expect(countTables('const f = (a: number) => a > 1; const b: Map<HarnessKind, number> = x;')).toBe(0);
  });
});

describe('the harness-literal gate', () => {
  test('is clean on this repository', () => {
    // Against this very commit, so the ratchet reads a base wherever the test runs; the ratchet itself is proven on
    // throwaway repositories below.
    const result = spawnSync('bash', [join(root, GATE)], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FY_CHECK_BASE: 'HEAD' },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  /** A pinned file: the list may hold it, at most at its pinned count. */
  const FILE = `${DAEMON}/lib/account/scope.ts`;
  /** A file the pin does not name. */
  const NEW_FILE = `${DAEMON}/lib/a.ts`;

  test('refuses a harness literal in a Runtimes daemon file', () => {
    const result = run({ [NEW_FILE]: "export const kind = 'codex';\n" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${NEW_FILE}::1`);
  });

  test('refuses a literal in a double-quoted comparison too', () => {
    expect(run({ [NEW_FILE]: 'if (x === "claude") go();\n' }).status).toBe(1);
  });

  test('does not read the four files that spell the stored word, a test, or another package', () => {
    const planted = "export const kind = 'claude';\n";
    const result = run({
      [`${DAEMON}/lib/harness-kind.ts`]: planted,
      [`${DAEMON}/lib/account/schema.ts`]: planted,
      [`${DAEMON}/lib/account/halves.ts`]: planted,
      [`${DAEMON}/lib/config.ts`]: planted,
      'packages/plugins/runtimes/tests/unit/a.test.ts': planted,
      'packages/plugins/codex/daemon/a.ts': planted,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('a listed file passes at its exact count', () => {
    expect(run({ [FILE]: "export const kind = 'codex';\n" }, { ledger: `${FILE}::1  # PR 17b\n` }).status).toBe(0);
  });

  test('a second literal in a listed file fails', () => {
    const result = run(
      { [FILE]: "export const a = 'codex';\nexport const b = 'claude';\n" },
      { ledger: `${FILE}::1  # PR 17b\n` },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${FILE}::2`);
  });

  test('a listed row for a file that is now clean fails, so a row only ever shrinks', () => {
    const result = run({ [FILE]: 'export const x = 1;\n' }, { ledger: `${FILE}::1  # PR 17b\n` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('delete or lower its row');
  });

  test('a row the base does not hold is refused, so a new literal cannot be blessed by listing it', () => {
    const result = run(
      { [FILE]: "export const kind = 'codex';\n" },
      { ledger: `${FILE}::1  # PR 17b\n`, base: '# nothing listed\n' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the base holds no such row');
  });

  test('a count above the base is refused and a count at or below it is allowed', () => {
    const two = "export const a = 'codex';\nexport const b = 'claude';\n";
    expect(run({ [FILE]: two }, { ledger: `${FILE}::2\n`, base: `${FILE}::1\n` }).status).toBe(1);
    expect(run({ [FILE]: two }, { ledger: `${FILE}::2\n`, base: `${FILE}::2\n` }).status).toBe(0);
  });

  test('the pin names exactly the four literal rows and the table rows of E-276 PR 17b, with their counts', () => {
    expect([...PINNED].map(([path, n]) => `${path.slice(DAEMON.length + 1)}::${n}`).toSorted()).toEqual([
      'adapters/host-harness-scan.ts::tables::1',
      'lib/account/builtin-autonomous.ts::2',
      'lib/account/halves.ts::tables::2',
      'lib/account/import-plan.ts::tables::2',
      'lib/account/import.ts::tables::1',
      'lib/account/layering.ts::2',
      'lib/account/materialise.ts::tables::1',
      'lib/account/scope.ts::4',
      'lib/assets.ts::tables::1',
      'lib/harness-kind.ts::tables::2',
      'lib/models/catalog.ts::tables::4',
      'lib/service/catalog.ts::tables::1',
      'lib/service/harness-facts.ts::tables::1',
      'lib/service/setup-service.ts::tables::1',
    ]);
  });

  /** A tracked Runtimes file the pin does not name, with a typed table whose keys are identifiers (no quoted literal). */
  const GATE_FILE = `${DAEMON}/lib/launch-gate.ts`;
  const TYPED_TABLE =
    "import type { HarnessKind } from './harness-kind.ts';\nexport const weight: Readonly<Record<HarnessKind, number>> = { claude: 1, codex: 2 };\n";

  test('refuses a typed per-harness table with unquoted keys in a tracked Runtimes file (no literal, no list change)', () => {
    const result = run({ [GATE_FILE]: TYPED_TABLE });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${tablesKey(GATE_FILE)}::1`);
  });

  test.each([
    ['a satisfies', 'export const w = { claude: 1, codex: 2 } as const satisfies Record<HarnessKind, number>;\n'],
    ['a mapped type over the kind', 'export type W = { readonly [Kind in HarnessKind]: number };\n'],
    [
      'a table typed by an import type',
      "export const w: Record<import('./harness-kind.ts').HarnessKind, number> = x;\n",
    ],
    ['a Partial table', 'export const w: Partial<Record<HarnessKind, number>> = {};\n'],
  ])('refuses %s, too', (_name, source) => {
    const result = run({ [GATE_FILE]: source });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${tablesKey(GATE_FILE)}::1`);
  });

  test('refuses a table in one of the four stored-word files too (it may spell the word, not hold a new table)', () => {
    const result = run({ [`${DAEMON}/lib/config.ts`]: TYPED_TABLE });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${tablesKey(`${DAEMON}/lib/config.ts`)}::1`);
  });

  test('a pinned table row passes at its count, and a second table in that file is refused', () => {
    const TABLES_FILE = `${DAEMON}/lib/settings.ts`;
    const ledger = `${tablesKey(TABLES_FILE)}::1\n`;
    expect(run({ [TABLES_FILE]: TYPED_TABLE }, { ledger }).status).toBe(0);
    const two = `${TYPED_TABLE}export type V = Record<HarnessKind, string>;\n`;
    const grown = run({ [TABLES_FILE]: two }, { ledger });
    expect(grown.status).toBe(1);
    expect(grown.stderr).toContain(`${tablesKey(TABLES_FILE)}::2`);
  });

  test('a table row the pin does not hold is refused even with matching code and a base that predates the list', () => {
    const result = run({ [GATE_FILE]: TYPED_TABLE }, { ledger: `${tablesKey(GATE_FILE)}::1  # a blessed table\n` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the pin holds no such row');
  });

  test('a table row left behind for a file with no table is refused', () => {
    const TABLES_FILE = `${DAEMON}/lib/settings.ts`;
    const result = run({ [TABLES_FILE]: 'export const x = 1;\n' }, { ledger: `${tablesKey(TABLES_FILE)}::1\n` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('delete or lower its row');
  });

  test('a regular expression after return does not count as a quoted literal', () => {
    const result = run({ [NEW_FILE]: "export function matches(input: string) { return /'codex'/.test(input); }\n" });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  /** The per-harness things the list names but the gate cannot count (values, not harness-keyed types): each must still be there. */
  const NAMED_GAPS: readonly (readonly [file: string, needle: string])[] = [
    [`${DAEMON}/adapters/profile-components.ts`, 'const SOURCES'],
    [`${DAEMON}/lib/account/credentials.ts`, 'const SIGN_IN_FILES'],
    ['packages/plugins/runtimes/contract/display-name.ts', 'const HARNESS_WORD'],
    ['packages/plugins/runtimes/contract/display-name.ts', 'const CLI_WORD'],
    ['packages/plugins/runtimes/contract/display-name.ts', 'const FERRETRY_SIGN_IN'],
    ['packages/plugins/runtimes/contract/harness-words.ts', "'claude-code': {"],
  ];

  test('every named exemption of the list is still where the list says (so the list cannot go stale)', () => {
    const list = readFileSync(join(root, LEDGER), 'utf8');
    for (const [file, needle] of NAMED_GAPS) {
      expect(readFileSync(join(root, file), 'utf8')).toContain(needle);
      expect(list).toContain(file.replace(`${DAEMON}/`, '').replace('packages/plugins/runtimes/contract/', ''));
    }
  });

  test('a NEW row with matching code is refused even when the base predates the list (the bootstrap)', () => {
    const result = run(
      { [NEW_FILE]: "export const kind = 'codex';\n" },
      { ledger: `${NEW_FILE}::1  # a blessed row\n` },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the pin holds no such row');
  });

  test('a RAISED count with matching code is refused even when the base predates the list', () => {
    const five = Array.from({ length: 5 }, (_, i) => `export const k${i} = 'codex';`).join('\n');
    const result = run({ [FILE]: `${five}\n` }, { ledger: `${FILE}::5\n` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('(the pin holds 4)');
  });

  test('a pinned row at or below its pinned count passes against a base that predates the list', () => {
    const four = Array.from({ length: 4 }, (_, i) => `export const k${i} = 'codex';`).join('\n');
    expect(run({ [FILE]: `${four}\n` }, { ledger: `${FILE}::4\n` }).status).toBe(0);
    expect(run({ [FILE]: "export const k = 'codex';\n" }, { ledger: `${FILE}::1\n` }).status).toBe(0);
  });

  test('a literal inside a template interpolation is refused, listed or not', () => {
    const planted = "export const label = `kind: ${flag ? 'claude' : 'other'}`;\n";
    const bare = run({ [NEW_FILE]: planted });
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain(`${NEW_FILE}::1`);
    const listed = run({ [NEW_FILE]: planted }, { ledger: `${NEW_FILE}::1\n` });
    expect(listed.status).toBe(1);
    expect(listed.stderr).toContain('the pin holds no such row');
  });

  test('a base that cannot be read is a broken gate, never skipped', () => {
    const result = run({ [FILE]: 'export const x = 1;\n' }, { missingBase: true });
    expect(result.status).toBe(2);
  });
});
