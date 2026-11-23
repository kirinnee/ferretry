import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = join(import.meta.dir, '../..');
const GATE = 'scripts/validate/no-closed-harness.sh';
const SCANNER = 'scripts/validate/no-closed-harness.ts';
const LEDGER = 'scripts/validate/no-closed-harness-allowlist.txt';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { force: true, recursive: true });
});

interface Setup {
  /** The ledger in the working tree. */
  readonly ledger?: string;
  /** The ledger at the base commit; `null` is a base that predates the ledger (the bootstrap). Default: `null`. */
  readonly base?: string | null;
  /** Name a base that does not exist, so the gate cannot read it. */
  readonly missingBase?: boolean;
}

/** A throwaway git repo holding the gate, a base commit and the planted sources; returns the gate's run. */
const run = (
  files: Record<string, string>,
  setup: Setup = {},
): { status: number | null; stderr: string; stdout: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'fy-closed-harness-'));
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

describe('the closed-harness gate', () => {
  test('is clean on this repository', () => {
    // Against this very commit, so the ratchet reads a base wherever the test runs (a one-commit CI checkout has no
    // origin/rebuild/5.0-after in its unit-test step); the ratchet itself is proven on throwaway repositories below.
    const result = spawnSync('bash', [join(root, GATE)], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FY_CHECK_BASE: 'HEAD' },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  const OFFENDERS: Record<string, string> = {
    'a closed union (stored words)': "export type Kind = 'claude' | 'codex';\n",
    'a closed union (plugin keys)': "export type Key = 'claude-code' | 'codex';\n",
    'a union written the other way round': "export type Key = 'codex' | 'claude-code';\n",
    'an array of the two': "export const ALL = ['claude', 'codex'] as const;\n",
    'an enum of the two': "export const S = z.enum(['claude-code', 'codex']);\n",
    'the transitional known key': "import type { KnownHarnessKey } from '@ferretry/core-ferrets/contract';\n",
    'the transitional known guard': 'const only = keys.filter(isKnownHarnessKey);\n',
    'a two-way branch on a harness': "const x = harness === 'codex' ? a : b;\n",
    'a branch on a nested harness': "if (resolution.harness !== 'claude') return;\n",
    'a branch on a harness key': "return harnessKey === 'claude-code';\n",
    'a branch written the other way round': "if ('codex' === summary.harness) go();\n",
  };
  for (const [name, source] of Object.entries(OFFENDERS))
    test(`refuses ${name}`, () => {
      const result = run({ 'packages/plugins/x/daemon/a.ts': source });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('packages/plugins/x/daemon/a.ts');
    });

  test('allows a provider, a catalog half and a tool that happen to be called claude', () => {
    const result = run({
      'packages/plugins/x/daemon/a.ts': [
        "if (half === 'claude') go();\n",
        "const tool = name === 'codex' ? 1 : 2;\n",
        "if (preset.id === 'claude') go();\n",
        "const only = harnesses.includes('claude');\n",
      ].join(''),
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('does not look at tests, the two harness plugins, or the file that declares the keys', () => {
    const closed = "export type K = 'claude' | 'codex';\nconst x = harness === 'codex';\n";
    const result = run({
      'packages/plugins/x/tests/unit/a.test.ts': closed,
      'packages/plugins/claude-code/daemon/a.ts': closed,
      'packages/plugins/codex/daemon/a.ts': closed,
      'packages/core/ferrets/contract/ids.ts': "export const KNOWN_HARNESS_KEYS = ['claude-code', 'codex'] as const;\n",
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  const PATH = 'packages/plugins/x/daemon/a.ts';
  const ROW = (kind: string, n: number) => `${PATH}::${kind}=${n}  # part 9\n`;

  test('a ledgered offender passes at its exact count', () => {
    expect(run({ [PATH]: "export type K = 'claude' | 'codex';\n" }, { ledger: ROW('literal', 1) }).status).toBe(0);
  });

  test('a second offender in a ledgered file fails', () => {
    const result = run(
      { [PATH]: "export type K = 'claude' | 'codex';\nexport type L = 'codex' | 'claude';\n" },
      { ledger: ROW('literal', 1) },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${PATH}::literal=2`);
  });

  test('a ledgered row for code that is now cleaner fails, so a row only ever shrinks', () => {
    const gone = run({ [PATH]: 'export const x = 1;\n' }, { ledger: ROW('literal', 1) });
    expect(gone.status).toBe(1);
    expect(gone.stderr).toContain('delete or lower its row');
    const lower = run({ [PATH]: "export type K = 'claude' | 'codex';\n" }, { ledger: ROW('literal', 3) });
    expect(lower.status).toBe(1);
  });

  // The forms an ordinary formatter or author writes. Each was invisible to the old line-by-line match.
  describe('every ordinary spelling of a closed set is seen', () => {
    const FORMS: Record<string, string> = {
      'the single-line control': "export type K = 'claude' | 'codex';\n",
      'a union split over two lines': "export type K = 'claude' |\n  'codex';\n",
      'a union with leading bars (as a formatter writes it)': "export type K =\n  | 'claude'\n  | 'codex';\n",
      'a double-quoted union': 'export type K = "claude-code" | "codex";\n',
      'a trailing-comma tuple': "export const ALL = ['claude', 'codex',] as const;\n",
      'a multi-line trailing-comma tuple': 'export const ALL = [\n  "claude-code",\n  "codex",\n] as const;\n',
      'a z.enum split over lines': "export const S = z.enum([\n  'codex',\n  'claude',\n]);\n",
      'a loose comparison': "if (harness == 'codex') go();\n",
      'a comparison split over two lines': "const x = resolution.harness ===\n  'codex' ? a : b;\n",
      'a double-quoted comparison': 'if (harnessKind !== "claude") return;\n',
    };
    for (const [name, source] of Object.entries(FORMS))
      test(`${name}: refused, and counted once`, () => {
        const result = run({ [PATH]: source });
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(new RegExp(`> ${PATH}::(literal|branch)=1\\b`));
      });

    test('a second literal on a line that already has a ledger row is a second hit', () => {
      const source = "export type K = 'claude' | 'codex'; export type L = 'codex' | 'claude';\n";
      const result = run({ [PATH]: source }, { ledger: ROW('literal', 1) });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`> ${PATH}::literal=2`);
      expect(run({ [PATH]: source }, { ledger: ROW('literal', 2) }).status).toBe(0);
    });

    test('two comparisons on one line are two hits', () => {
      const source = "const both = harness === 'codex' || harness === 'claude';\n";
      expect(run({ [PATH]: source }, { ledger: ROW('branch', 1) }).stderr).toContain(`> ${PATH}::branch=2`);
    });
  });

  // The ratchet: the ledger may not grow against the BASE ledger, so a new offender cannot bless itself with its own row.
  describe('the ledger only shrinks against the base', () => {
    const closed = "export type K = 'claude' | 'codex';\n";

    test('a new union plus a new matching row fails', () => {
      const result = run({ [PATH]: closed }, { base: '', ledger: ROW('literal', 1) });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('grew against');
      expect(result.stderr).toContain(`+ ${PATH}::literal=1 (the base holds no such row)`);
    });

    test('a higher count on a row the base holds fails', () => {
      const source = `${closed}export type L = 'codex' | 'claude';\n`;
      const result = run({ [PATH]: source }, { base: ROW('literal', 1), ledger: ROW('literal', 2) });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`+ ${PATH}::literal=2 (the base holds 1)`);
    });

    test('the same row, a lower count and a deleted row all pass', () => {
      expect(run({ [PATH]: closed }, { base: ROW('literal', 1), ledger: ROW('literal', 1) }).status).toBe(0);
      expect(run({ [PATH]: closed }, { base: ROW('literal', 3), ledger: ROW('literal', 1) }).status).toBe(0);
      expect(run({ [PATH]: 'export const x = 1;\n' }, { base: ROW('literal', 1), ledger: '' }).status).toBe(0);
    });

    test('a base that predates the ledger is the bootstrap: the current ledger is accepted', () => {
      expect(run({ [PATH]: closed }, { base: null, ledger: ROW('literal', 1) }).status).toBe(0);
    });

    test('a base that cannot be read is a broken gate, never a pass', () => {
      const result = run({ [PATH]: closed }, { ledger: ROW('literal', 1), missingBase: true });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('cannot read the base');
    });

    test('--print writes the rows of the current tree', () => {
      const dir = mkdtempSync(join(tmpdir(), 'fy-closed-harness-'));
      scratch.push(dir);
      mkdirSync(join(dir, 'scripts/validate'), { recursive: true });
      for (const file of [GATE, SCANNER]) copyFileSync(join(root, file), join(dir, file));
      writeFileSync(join(dir, LEDGER), '');
      mkdirSync(join(dir, dirname(PATH)), { recursive: true });
      writeFileSync(join(dir, PATH), closed);
      spawnSync('git', ['init', '-q'], { cwd: dir });
      spawnSync('git', ['add', '-A'], { cwd: dir });
      const result = spawnSync('bash', [join(dir, GATE), '--print'], { cwd: dir, encoding: 'utf8' });
      expect(result.stdout).toBe(`${PATH}::literal=1\n`);
      expect(result.status).toBe(0);
    });
  });

  test('a missing ledger is a broken gate, not a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fy-closed-harness-'));
    scratch.push(dir);
    mkdirSync(join(dir, 'scripts/validate'), { recursive: true });
    for (const file of [GATE, SCANNER]) copyFileSync(join(root, file), join(dir, file));
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const result = spawnSync('bash', [join(dir, GATE)], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(2);
  });
});
