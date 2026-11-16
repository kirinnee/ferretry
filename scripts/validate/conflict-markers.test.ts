import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The shapes are built, never written, so this file is not itself a conflict marker to the gate it tests.
const raw = (ch: string): string => ch.repeat(7);
const laundered = (ch: string): string => Array.from({ length: 7 }, () => ch).join(' ');

// The gate script quotes every shape it refuses, so any allowlist a test writes declares it first.
const SELF = 'scripts/validate/conflict-markers.sh  # quotes every shape it refuses';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A throwaway git repository holding the real gate script, its real allowlist and the given tracked files. */
function repo(files: Readonly<Record<string, string>>, allowlist?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'fy-conflict-markers-'));
  temporary.push(directory);
  const put = (file: string, content: string) => {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  mkdirSync(join(directory, 'scripts/validate'), { recursive: true });
  copyFileSync(join(import.meta.dir, 'conflict-markers.sh'), join(directory, 'scripts/validate/conflict-markers.sh'));
  if (allowlist === undefined)
    copyFileSync(
      join(import.meta.dir, 'conflict-markers-allowlist.txt'),
      join(directory, 'scripts/validate/conflict-markers-allowlist.txt'),
    );
  else put('scripts/validate/conflict-markers-allowlist.txt', `${SELF}\n${allowlist}`);
  for (const [file, content] of Object.entries(files)) put(file, content);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: directory });
  git('init', '-q');
  git('add', '-A');
  return {
    run: () => {
      const result = spawnSync('bash', ['scripts/validate/conflict-markers.sh'], { cwd: directory, encoding: 'utf8' });
      return { code: result.status, out: `${result.stdout}${result.stderr}` };
    },
  };
}

test('G73 the gate recognises the formatter-laundered shape as well as the raw one', () => {
  for (const [name, line] of [
    ['a raw opener', `${raw('<')} HEAD`],
    ['a raw closer', `${raw('>')} abc1234`],
    ['a raw base marker', `${raw('|')} base`],
    ['a laundered closer', `${laundered('>')} abc1234`],
    ['a laundered opener', `${laundered('<')} HEAD`],
    ['a setext divider', raw('=')],
  ] as const) {
    const { code, out } = repo({ 'docs/damaged.md': `before\n${line}\nafter\n` }).run();
    expect([name, code]).toEqual([name, 1]);
    expect(out).toContain('docs/damaged.md:2:');
  }
});

test('G73 the laundered shape is found indented inside a nested blockquote, not only at the start of a line', () => {
  const { code, out } = repo({ 'docs/nested.md': `> quoted\n> > ${laundered('>')} abc1234\n` }).run();
  expect(code).toBe(1);
  expect(out).toContain('docs/nested.md:2:');
});

test('G73 a clean tree passes and a divider rule that is not seven equals signs is not a marker', () => {
  const { code, out } = repo({ 'docs/clean.md': `title\n${'='.repeat(6)}\n${'='.repeat(8)}\n` }).run();
  expect(code).toBe(0);
  expect(out).toContain('no undeclared merge-conflict markers');
});

test('G73 a declared documentation file is exempt and its neighbour is not', () => {
  const allowlist = '# test\ndocs/teaches.md  # shows the shapes it teaches\n';
  const teaching = `${raw('<')} HEAD\n`;
  expect(repo({ 'docs/teaches.md': teaching }, allowlist).run().code).toBe(0);
  const neighbour = repo({ 'docs/teaches.md': teaching, 'docs/other.md': teaching }, allowlist).run();
  expect(neighbour.code).toBe(1);
  expect(neighbour.out).toContain('docs/other.md:1:');
  expect(neighbour.out).not.toContain('docs/teaches.md:1:');
});

test('G73 a reasonless, globbed or duplicated declaration is a broken gate (exit 2), never a clean tree', () => {
  expect(repo({ 'docs/a.md': 'x\n' }, 'docs/a.md\n').run().code).toBe(2);
  expect(repo({ 'docs/a.md': 'x\n' }, 'docs/*.md  # all docs\n').run().code).toBe(2);
  expect(repo({ 'docs/a.md': 'x\n' }, 'docs/a.md  # one\ndocs/a.md  # two\n').run().code).toBe(2);
});
