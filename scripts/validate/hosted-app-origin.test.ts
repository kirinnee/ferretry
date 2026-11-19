import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const line = '  FY_HOSTED_APP_ORIGIN: https://preview.example';

/** The real gate, asked what origin a throwaway workflow sets at workflow level. */
function origin(workflow: string) {
  const directory = mkdtempSync(join(tmpdir(), 'fy-hosted-app-origin-'));
  temporary.push(directory);
  const file = join(directory, 'workflow.yaml');
  writeFileSync(file, workflow);
  const result = spawnSync('bash', [join(import.meta.dir, 'hosted-app-origin.sh'), '--workflow-origin', file], {
    encoding: 'utf8',
  });
  return { code: result.status, out: result.stdout.trim(), err: result.stderr };
}

test('the origin under the workflow-level env block is read', () => {
  const result = origin(`name: x\non:\n  push:\nenv:\n  OTHER: 1\n${line}\njobs:\n  a:\n    runs-on: x\n`);
  expect(result.code).toBe(0);
  expect(result.out).toBe('https://preview.example');
});

test('the same line under another top-level block is refused', () => {
  const result = origin(`name: x\nrun-name: |\n${line}\nenv:\n  OTHER: 1\njobs:\n  a:\n    runs-on: x\n`);
  expect(result.code).toBe(1);
  expect(result.err).toContain('exactly once');
});

test('the line only under another top-level block, with no env block value, is refused', () => {
  const result = origin(`name: x\nenv:\n  OTHER: 1\nrun-name: |\n${line}\n`);
  expect(result.code).toBe(1);
  expect(result.err).toContain('found 0 there, 1 in all');
});

test('a missing line is refused', () => {
  const result = origin('name: x\nenv:\n  OTHER: 1\njobs:\n  a:\n    runs-on: x\n');
  expect(result.code).toBe(1);
  expect(result.err).toContain('found 0 there, 0 in all');
});

test('a duplicate under env is refused', () => {
  const result = origin(`name: x\nenv:\n${line}\n  FY_HOSTED_APP_ORIGIN: https://other.example\n`);
  expect(result.code).toBe(1);
  expect(result.err).toContain('found 2 there');
});

test('a second copy under another top-level block beside the right one is refused', () => {
  const result = origin(`name: x\nenv:\n${line}\nrun-name: |\n${line}\n`);
  expect(result.code).toBe(1);
  expect(result.err).toContain('found 1 there, 2 in all');
});
