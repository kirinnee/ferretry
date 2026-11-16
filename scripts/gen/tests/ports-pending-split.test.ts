/**
 * The pending lists live in one file per owning package plus a small root file (`lib/pending-files.ts`). These tests pin
 * the rule: every file is read, a line named twice fails, a file outside the rule fails, and an entry that moves between
 * files is neither closed nor added.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { portsPendingLines } from '../../validate/after-merge.ts';
import { check as portsPending, ownershipFindings, readPending } from '../../validate/ports-pending.ts';
import { contextFor } from '../lib/check.ts';
import { pendingFilePaths, readPendingMerged, readPendingMergedBase } from '../lib/pending-files.ts';
import { type Fixture, fixture, skeletonHalf } from './fixture.ts';

const made: Fixture[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const f of made) f.dispose();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const ws = (options: Parameters<typeof fixture>[1] = {}, ids: readonly string[] = ['alpha', 'beta']): Fixture => {
  const f = fixture(
    ids.map(id => ({ id, daemon: skeletonHalf('Daemon'), app: skeletonHalf('App'), cli: skeletonHalf('Cli') })),
    options,
  );
  made.push(f);
  return f;
};
const tree = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pending-split-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
};
const doc = (value: object): string => JSON.stringify({ format: 1, ...value });
const HALVES = ['daemon', 'app', 'cli'];
const found = async (f: Fixture, base: string): Promise<string> =>
  (await portsPending.run(contextFor(f.root, { base }))).map(x => `${x.where}: ${x.message}`).join('\n');

describe('ports-pending split across files', () => {
  test('every file is read: the lists merge and the total counts every line', () => {
    const dir = tree({
      'ports-pending.json': doc({ unwired: [] }),
      'packages/plugins/alpha/ports-pending.json': doc({
        pending: ['alpha'],
        pendingReasons: { alpha: ['one', 'two'] },
        pendingHalves: { alpha: HALVES },
      }),
      'packages/core/beta/ports-pending.json': doc({ pending: ['beta'], pendingReasons: { beta: ['three'] } }),
    });
    const merged = readPending(dir);
    expect([...merged.pending].sort()).toEqual(['alpha', 'beta']);
    expect(merged.halves).toEqual({ alpha: HALVES });
    expect(portsPendingLines(dir)).toBe(3);
    expect(ownershipFindings(dir)).toEqual([]);
  });

  test('a duplicate across two files fails (an id, and a reasons key)', async () => {
    const dir = tree({
      'packages/plugins/alpha/ports-pending.json': doc({ pending: ['alpha'] }),
      'packages/core/alpha/ports-pending.json': doc({ pending: ['alpha'] }),
    });
    expect(() => readPending(dir)).toThrow('pending alpha is listed twice');
    const reasons = tree({
      'packages/plugins/alpha/ports-pending.json': doc({ pendingReasons: { alpha: ['a'] } }),
      'ports-pending.json': doc({ pendingReasons: { alpha: ['b'] } }),
    });
    expect(() => readPending(reasons)).toThrow('pendingReasons.alpha is listed twice');
    const f = ws({ pending: ['alpha'] });
    f.write('packages/core/alpha/ports-pending.json', doc({ pending: ['alpha'] }));
    expect(await found(f, 'file:/nonexistent')).toContain('listed twice');
  });

  test('a file outside the rule fails, and so does a line kept by the wrong owner', async () => {
    const f = ws({ pending: ['alpha'], pendingHalves: { alpha: HALVES } }, ['alpha']);
    expect(await found(f, 'file:/nonexistent')).toBe('');
    f.write('docs/ports-pending.json', doc({ pending: [] }));
    f.write('packages/shared/ports-pending.json', doc({ pending: [] }));
    f.write('packages/plugins/alpha/deeper/ports-pending.json', doc({ pending: [] }));
    const outside = (await portsPending.run(contextFor(f.root, { base: 'file:/nonexistent' }))).map(x => x.where);
    expect(outside).toContain('docs/ports-pending.json');
    expect(outside).toContain('packages/shared/ports-pending.json');
    expect(outside).toContain('packages/plugins/alpha/deeper/ports-pending.json');
    const wrong = tree({
      'packages/plugins/alpha/ports-pending.json': doc({ pending: ['beta'], pendingReasons: { beta: ['x'] } }),
      'ports-pending.json': doc({ pending: ['gamma'] }),
    });
    const messages = ownershipFindings(wrong).map(x => `${x.where}: ${x.message}`);
    expect(messages.some(m => m.startsWith('packages/plugins/alpha/ports-pending.json: holds beta'))).toBe(true);
    expect(messages.some(m => m.startsWith('ports-pending.json: holds gamma'))).toBe(true);
  });

  const lists = {
    pending: ['alpha', 'beta'],
    pendingHalves: { alpha: HALVES, beta: HALVES },
    pendingReasons: { alpha: ['a1'], beta: ['b1', 'b2'] },
  };

  test('an entry that moves between files is neither closed nor added, and the total is unchanged', async () => {
    // The base holds every line in one root file (the old layout); the head holds the same lines in the owners' files.
    const base = tree({ 'ports-pending.json': doc(lists) });
    const f = ws(lists);
    expect(await found(f, `file:${base}`)).toBe('');
    expect(portsPendingLines(f.root)).toBe(3);
    expect(JSON.parse(readPendingMerged(base) ?? '{}').pendingReasons).toEqual(readPending(f.root).reasons);
    // The reverse move (owners' files in the base, one file in the head) is as quiet.
    const split = tree({
      'packages/plugins/alpha/ports-pending.json': doc({
        pending: ['alpha'],
        pendingHalves: { alpha: HALVES },
        pendingReasons: { alpha: ['a1'] },
      }),
      'packages/plugins/beta/ports-pending.json': doc({
        pending: ['beta'],
        pendingHalves: { beta: HALVES },
        pendingReasons: { beta: ['b1', 'b2'] },
      }),
    });
    expect(await found(f, `file:${split}`)).toBe('');
  });

  test('closing an entry is quiet; adding one in any file fails', async () => {
    const base = tree({ 'ports-pending.json': doc(lists) });
    const closed = ws({ pending: ['alpha'], pendingHalves: { alpha: HALVES }, pendingReasons: { alpha: ['a1'] } }, [
      'alpha',
    ]);
    expect(await found(closed, `file:${base}`)).toBe('');
    const betaOnly = tree({
      'packages/plugins/beta/ports-pending.json': doc({ pending: ['beta'], pendingHalves: { beta: HALVES } }),
    });
    const added = ws(lists);
    expect(await found(added, `file:${betaOnly}`)).toContain('alpha was added; the list may only shrink');
  });

  test('a git ref is read file by file, and a ref with no pending file has no baseline', () => {
    const git = (cwd: string, ...args: string[]): void => {
      const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
      if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    };
    const dir = tree({
      'ports-pending.json': doc({ unwired: [] }),
      'packages/plugins/alpha/ports-pending.json': doc({ pending: ['alpha'], pendingReasons: { alpha: ['a'] } }),
      'packages/plugins/alpha/other.json': '{}',
    });
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    const merged = JSON.parse(readPendingMergedBase(dir, 'HEAD') ?? '{}');
    expect(merged.pending).toEqual(['alpha']);
    expect(merged.unwired).toEqual([]);
    expect(() => readPendingMergedBase(dir, 'no-such-ref')).toThrow();
    expect(readPendingMergedBase(tree({}), 'file:/nonexistent')).toBeUndefined();
  });

  test('a pending file under a dot directory is found and rejected, not skipped', async () => {
    const f = ws({ pending: ['alpha'], pendingHalves: { alpha: HALVES } }, ['alpha']);
    f.write('.mistyped/ports-pending.json', doc({ pending: ['ghost'], pendingReasons: { ghost: ['a hidden gap'] } }));
    expect(pendingFilePaths(f.root)).toContain('.mistyped/ports-pending.json');
    const findings = await portsPending.run(contextFor(f.root, { base: 'file:/nonexistent' }));
    expect(
      findings.some(x => x.where === '.mistyped/ports-pending.json' && x.message.includes('outside the rule')),
    ).toBe(true);
  });

  test('only metadata and dependency trees are skipped: .git, node_modules, .worktrees, .direnv', () => {
    const dir = tree({
      'ports-pending.json': doc({ unwired: [] }),
      '.git/ports-pending.json': doc({}),
      'node_modules/pkg/ports-pending.json': doc({}),
      '.worktrees/other/ports-pending.json': doc({}),
      '.direnv/ports-pending.json': doc({}),
      '.other/ports-pending.json': doc({}),
      'packages/plugins/alpha/node_modules/x/ports-pending.json': doc({}),
    });
    expect(pendingFilePaths(dir)).toEqual(['.other/ports-pending.json', 'ports-pending.json']);
  });

  test('the gen tests’ own fixture folder is skipped by its path, and no other folder of that name is', () => {
    const dir = tree({
      'ports-pending.json': doc({ unwired: [] }),
      'scripts/gen/tests/.tmp/w1/packages/plugins/alpha/ports-pending.json': doc({}),
      'scripts/gen/tests/.tmp/w2/packages/plugins/alpha/ports-pending.json': doc({}),
      'scripts/other/.tmp/ports-pending.json': doc({}),
      'scripts/gen/tests/ports-pending.json': doc({}),
    });
    expect(pendingFilePaths(dir)).toEqual([
      'ports-pending.json',
      'scripts/gen/tests/ports-pending.json',
      'scripts/other/.tmp/ports-pending.json',
    ]);
  });

  test('a git ref lists every pending filename, so an out-of-rule file reaches the checks', () => {
    const dir = tree({
      'ports-pending.json': doc({ unwired: [] }),
      '.mistyped/ports-pending.json': doc({ pending: ['ghost'] }),
      'docs/ports-pending.json': doc({ pending: ['stray'] }),
    });
    const run = (...args: string[]): void => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: dir,
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    run('init', '-q');
    run('add', '-A');
    run('commit', '-q', '-m', 'base');
    const merged = JSON.parse(readPendingMergedBase(dir, 'HEAD') ?? '{}');
    expect([...merged.pending].sort()).toEqual(['ghost', 'stray']);
  });
});

describe('ownership of unwired seams', () => {
  const seam = (path: string): object => ({ seam: `code:${path}`, card: '&F1', why: 'a gap' });
  const alpha = 'packages/plugins/alpha/daemon/index.ts:missing';
  const messages = (files: Record<string, string>): string[] =>
    ownershipFindings(tree(files)).map(x => `${x.where}: ${x.message}`);

  test("alpha's code seam in beta's file is a finding", () => {
    const found = messages({
      'ports-pending.json': doc({ unwired: [] }),
      'packages/plugins/beta/ports-pending.json': doc({ unwired: [seam(alpha)] }),
    });
    expect(found.some(m => m.startsWith('packages/plugins/beta/ports-pending.json:') && m.includes('alpha'))).toBe(
      true,
    );
  });

  test("alpha's code seam in the root file is a finding", () => {
    const found = messages({ 'ports-pending.json': doc({ unwired: [seam(alpha)] }) });
    expect(found.some(m => m.startsWith('ports-pending.json:') && m.includes('alpha'))).toBe(true);
  });

  test("alpha's code seam in its own file, and a hook seam in the root, are clean", () => {
    expect(
      messages({
        'ports-pending.json': doc({ unwired: [{ seam: 'hook:card.moving', card: '&F1', why: 'a hook' }] }),
        'packages/plugins/alpha/ports-pending.json': doc({ unwired: [seam(alpha)] }),
      }),
    ).toEqual([]);
  });

  test('the real Accounts seam moved to the root is a finding', () => {
    const accounts = 'packages/plugins/accounts/daemon/index.ts:notBuiltRoute';
    expect(messages({ 'ports-pending.json': doc({ unwired: [seam(accounts)] }) }).length).toBeGreaterThan(0);
  });

  test('a malformed unwired entry is a finding, not a crash', () => {
    const found = messages({
      'packages/plugins/alpha/ports-pending.json': doc({ unwired: [{ seam: 3 }, 'x'] }),
    });
    expect(found.length).toBeGreaterThan(0);
  });
});
