import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = join(import.meta.dir, '../..');
const GATE = 'scripts/validate/no-native-select.sh';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** A throwaway git repo holding the gate and the planted sources; returns the gate's run. */
const run = (files: Record<string, string>): { status: number | null; stderr: string; stdout: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'fy-native-select-'));
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

const SELECT = 'export const Probe = () => <select></select>;\n';

describe('the no-native-select gate', () => {
  test('is clean on this repository', () => {
    const result = spawnSync('bash', [join(root, GATE)], { cwd: root, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  for (const path of [
    'packages/app/src/a.tsx',
    'packages/app/src/ui/deep/a.tsx',
    'packages/core/vault/app/a.tsx',
    'packages/core/vault/app/features/a.tsx',
    'packages/plugins/usage/app/a.tsx',
    'packages/plugins/usage/app/features/usage/a.tsx',
  ])
    test(`refuses a native select in ${path}`, () => {
      const result = run({ [path]: SELECT });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(path);
    });

  for (const [name, source] of [
    ['spaced attributes', 'export const P = () => <select value={v}></select>;\n'],
    ['a compact self-closing element', 'export const P = () => <select/>;\n'],
    ['a compact element with the slash after a space', 'export const P = () => <select />;\n'],
    ['an element ending the line', 'export const P = () => (\n  <select\n    value={v}\n  />\n);\n'],
  ] as const)
    test(`refuses ${name}`, () => {
      const result = run({ 'packages/plugins/usage/app/a.tsx': source });
      expect(result.status).toBe(1);
    });

  test('leaves test fixtures and tests under a plugin or core package alone', () => {
    const result = run({
      'packages/plugins/usage/tests/integration/app/fixtures/scene.tsx': SELECT,
      'packages/plugins/usage/tests/unit/app/a.tsx': SELECT,
      'packages/core/vault/tests/integration/app/fixtures/scene.tsx': SELECT,
      'packages/core/vault/tests/a.tsx': SELECT,
      'packages/app/tests/fixtures/scene.tsx': SELECT,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  for (const [name, source] of [
    ['an element after a closed block comment', '/* x */ <select>\n'],
    ['an element after two closed block comments', '/* a */ /* b */ <select/>\n'],
    ['an element after a closed doc comment', '/** why */ <select value={v}></select>\n'],
  ] as const)
    test(`refuses ${name}`, () => {
      const result = run({ 'packages/plugins/usage/app/a.tsx': source });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('packages/plugins/usage/app/a.tsx');
    });

  test('allows a comment-only line and the shared SelectBox', () => {
    const result = run({
      'packages/plugins/usage/app/a.tsx':
        '// <select> is banned\n/* <select/> */\n * <select>\nexport const P = () => <SelectBox />;\n',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
