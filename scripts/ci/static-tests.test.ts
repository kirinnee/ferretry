import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Quick's `scripts` part and Static's `guards` part (scripts/ci/quick-part.sh) split the repository-tooling tests by
// config/static-tests.txt. Neither may drop a test: together they run every file Bun would collect under scripts/,
// and no file runs in both. A list naming a file that does not exist, or naming nothing, fails both parts.
const ROOT = join(import.meta.dir, '..', '..');
const PART = join(ROOT, 'scripts/ci/quick-part.sh');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const list = (part: 'scripts' | 'guards', cwd = ROOT) => {
  const result = spawnSync('bash', [PART, part], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FY_QUICK_PART_LIST: '1' },
  });
  return { status: result.status, files: result.stdout.split('\n').filter(Boolean), err: result.stderr };
};
/** Every test file Bun collects under scripts/ (its default name patterns), found independently of quick-part.sh. */
const collected = (): string[] =>
  [...new Bun.Glob('scripts/**/*{.test,_test,.spec,_spec}.*').scanSync({ cwd: ROOT, onlyFiles: true })]
    .filter(path => !path.includes('node_modules/'))
    .sort();

test('the two parts cover every scripts test exactly once', () => {
  const scripts = list('scripts');
  const guards = list('guards');
  expect(scripts.status).toBe(0);
  expect(guards.status).toBe(0);
  expect(guards.files.length).toBeGreaterThan(0);
  expect(scripts.files.filter(file => guards.files.includes(file))).toEqual([]);
  expect([...scripts.files, ...guards.files].sort()).toEqual(collected());
});

test('a static list naming a missing file, or naming nothing, fails both parts', () => {
  for (const text of ['scripts/gen/tests/gone.test.ts\n', '# nothing\n']) {
    const root = mkdtempSync(join(tmpdir(), 'fy-static-tests-'));
    roots.push(root);
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'scripts/gen/tests'), { recursive: true });
    writeFileSync(join(root, 'scripts/gen/tests/kept.test.ts'), '');
    writeFileSync(join(root, 'config/static-tests.txt'), text);
    copyFileSync(PART, join(root, 'quick-part.sh'));
    for (const part of ['scripts', 'guards'] as const) {
      const result = spawnSync('bash', ['quick-part.sh', part], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, FY_QUICK_PART_LIST: '1' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
    }
  }
});
