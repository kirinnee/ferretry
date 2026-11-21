import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = join(import.meta.dir, '../..');
const GATE = 'scripts/validate/no-stray-spinner.sh';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** A throwaway git repo holding the gate and the planted sources; returns the gate's run. */
const run = (files: Record<string, string>): { status: number | null; stderr: string; stdout: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'fy-stray-spinner-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'scripts/validate'), { recursive: true });
  copyFileSync(join(root, GATE), join(dir, GATE));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  return spawnSync('bash', [join(dir, GATE)], { cwd: dir, encoding: 'utf8' });
};

const SPIN = '<LoaderCircle className="animate-spin" size={14} />';

describe('the stray spinner gate', () => {
  test('is clean on this repository', () => {
    const result = spawnSync('bash', [join(root, GATE)], { cwd: root, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  for (const path of [
    'packages/app/src/a.tsx',
    'packages/core/ferrets/app/a.tsx',
    'packages/plugins/agenda/app/features/a.tsx',
  ])
    test(`refuses an animate-spin icon in ${path}`, () => {
      const result = run({ [path]: `export const A = () => ${SPIN};\n` });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(path);
    });

  test('allows the shared spinner, a test and a stylesheet that name the class', () => {
    const result = run({
      'packages/plugins/agenda/app/a.tsx': 'export const A = () => <Spinner size={14} wait />;\n',
      'packages/plugins/agenda/tests/a.test.tsx': `expect(x).toBe('animate-spin');\n`,
      'packages/app/src/ui/a.css': '.animate-spin { animation: none; }\n',
      'packages/daemon/src/a.ts': `export const A = 'animate-spin';\n`,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
