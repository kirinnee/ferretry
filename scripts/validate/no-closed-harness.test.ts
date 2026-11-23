import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = join(import.meta.dir, '../..');
const GATE = 'scripts/validate/no-closed-harness.sh';
const LEDGER = 'scripts/validate/no-closed-harness-allowlist.txt';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** A throwaway git repo holding the gate, a ledger, and the planted sources; returns the gate's run. */
const run = (files: Record<string, string>, ledger = ''): { status: number | null; stderr: string; stdout: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'fy-closed-harness-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'scripts/validate'), { recursive: true });
  copyFileSync(join(root, GATE), join(dir, GATE));
  writeFileSync(join(dir, LEDGER), ledger);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  return spawnSync('bash', [join(dir, GATE)], { cwd: dir, encoding: 'utf8' });
};

describe('the closed-harness gate', () => {
  test('is clean on this repository', () => {
    const result = spawnSync('bash', [join(root, GATE)], { cwd: root, encoding: 'utf8' });
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

  test('a ledgered offender passes at its exact count', () => {
    const source = "export type K = 'claude' | 'codex';\n";
    const path = 'packages/plugins/x/daemon/a.ts';
    expect(run({ [path]: source }, `${path}::literal=1  # part 9\n`).status).toBe(0);
  });

  test('a second offender in a ledgered file fails', () => {
    const path = 'packages/plugins/x/daemon/a.ts';
    const result = run(
      { [path]: "export type K = 'claude' | 'codex';\nexport type L = 'codex' | 'claude';\n" },
      `${path}::literal=1  # part 9\n`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path}::literal=2`);
  });

  test('a ledgered row for code that is now cleaner fails, so a row only ever shrinks', () => {
    const path = 'packages/plugins/x/daemon/a.ts';
    const gone = run({ [path]: 'export const x = 1;\n' }, `${path}::literal=1  # part 9\n`);
    expect(gone.status).toBe(1);
    expect(gone.stderr).toContain('delete or lower its row');
    const lower = run({ [path]: "export type K = 'claude' | 'codex';\n" }, `${path}::literal=3  # part 9\n`);
    expect(lower.status).toBe(1);
  });

  test('a missing ledger is a broken gate, not a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fy-closed-harness-'));
    scratch.push(dir);
    mkdirSync(join(dir, 'scripts/validate'), { recursive: true });
    copyFileSync(join(root, GATE), join(dir, GATE));
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const result = spawnSync('bash', [join(dir, GATE)], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(2);
  });
});
