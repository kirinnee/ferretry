import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { countLiterals, PINNED } from './no-harness-literal.ts';

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

  test('the pin names exactly the four rows of E-276 PR 17b, with their counts', () => {
    expect([...PINNED].map(([path, n]) => `${path.slice(DAEMON.length + 1)}::${n}`).toSorted()).toEqual([
      'lib/account/builtin-autonomous.ts::2',
      'lib/account/layering.ts::2',
      'lib/account/scope.ts::4',
      'lib/service/foreign.ts::2',
    ]);
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
