import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A throwaway repo holding the real gate and the given untracked files under packages/. */
function run(files: Readonly<Record<string, string>>) {
  const directory = mkdtempSync(join(tmpdir(), 'fy-no-legacy-state-'));
  temporary.push(directory);
  mkdirSync(join(directory, 'scripts/validate'), { recursive: true });
  copyFileSync(join(import.meta.dir, 'no-legacy-state.sh'), join(directory, 'scripts/validate/no-legacy-state.sh'));
  spawnSync('git', ['init', '-q'], { cwd: directory });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  const result = spawnSync('bash', ['scripts/validate/no-legacy-state.sh'], { cwd: directory, encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test('a clean package passes', () => {
  expect(run({ 'packages/a/src/x.ts': 'export const x = 1;\n' }).code).toBe(0);
});

test('a legacy identifier in package code fails', () => {
  const { code, out } = run({ 'packages/a/src/x.ts': "export const x = 'KTEAM_HOME';\n" });
  expect(code).toBe(1);
  expect(out).toContain('legacy identifiers or state paths found');
});

test("a tool's scratch folder (wrangler's .wrangler/tmp bundles) is not scanned", () => {
  const { code, out } = run({
    'packages/a/src/x.ts': 'export const x = 1;\n',
    'packages/a/.wrangler/tmp/bundle-1/index.js': "const x = 'KTEAM_HOME';\n",
    'packages/a/.turbo/log.txt': 'kfleet\n',
  });
  expect(out).not.toContain('KTEAM_HOME');
  expect(code).toBe(0);
});
