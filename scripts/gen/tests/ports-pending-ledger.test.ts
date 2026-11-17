/**
 * The pending ledger is one file per open line under each owner's `ports-pending/` folder (`lib/pending-files.ts`).
 * These tests pin the rule: every file is read, a malformed or misplaced one fails, a plugin is pending while it holds a
 * gap, the ledger only shrinks against the base, an old-layout base still answers, and two branches that each close a
 * neighbouring line merge clean.
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
  const dir = mkdtempSync(join(tmpdir(), 'pending-ledger-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
};
const git = (cwd: string, ...args: string[]): string => {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
};
const HALVES = ['daemon', 'app', 'cli'];
const halves = (id: string, list: readonly string[] = HALVES): Record<string, string> =>
  Object.fromEntries(list.map(h => [`packages/plugins/${id}/ports-pending/halves/${h}.txt`, '']));
const gap = (id: string, slug: string, line: string): Record<string, string> => ({
  [`packages/plugins/${id}/ports-pending/${slug}.txt`]: `${line}\n`,
});
const found = async (f: Fixture, base: string): Promise<string> =>
  (await portsPending.run(contextFor(f.root, { base }))).map(x => `${x.where}: ${x.message}`).join('\n');

describe('the ports-pending ledger: one file per open line', () => {
  test('every file is read: the lines merge, a plugin is pending while it holds a gap, and the total counts every file', () => {
    const dir = tree({
      ...gap('alpha', 'one', '[own] one'),
      ...gap('alpha', 'two', '[own] two'),
      ...halves('alpha'),
      'packages/core/beta/ports-pending/three.txt': '[own] three\n',
      'ports-pending/unwired/hook-x.json': JSON.stringify({ seam: 'hook:x', card: '&F1', why: 'a hook' }),
    });
    const merged = readPending(dir);
    expect([...merged.pending].sort()).toEqual(['alpha', 'beta']);
    expect(merged.reasons).toEqual({ alpha: ['[own] one', '[own] two'], beta: ['[own] three'] });
    expect(merged.slugs).toEqual({ alpha: ['one', 'two'], beta: ['three'] });
    expect(merged.halves).toEqual({ alpha: ['app', 'cli', 'daemon'] });
    expect(portsPendingLines(dir)).toBe(3);
    expect(ownershipFindings(dir)).toEqual([]);
  });

  test('a gap file keeps its line byte for byte, spaces and backticks included', () => {
    const line = '[kernel: x] GAP(kernel): `fy  login` keeps  two spaces, `<tags>` and *stars*';
    const dir = tree(gap('alpha', 'kernel-x', line));
    expect(readPending(dir).reasons).toEqual({ alpha: [line] });
  });

  test('a file outside the rule fails: a stray folder, a wrong name, an empty or multi-line gap', () => {
    const dir = tree({
      ...gap('alpha', 'fine', '[own] fine'),
      'packages/plugins/alpha/ports-pending/Bad_Name.txt': '[own] x\n',
      'packages/plugins/alpha/ports-pending/note.md': '[own] x\n',
      'packages/plugins/alpha/ports-pending/empty.txt': '\n',
      'packages/plugins/alpha/ports-pending/two-lines.txt': 'a\nb\n',
      'packages/plugins/alpha/ports-pending/halves/web.txt': '',
      'packages/plugins/alpha/ports-pending/elsewhere/x.txt': 'x\n',
      'packages/plugins/alpha/deeper/ports-pending/x.txt': 'x\n',
      'docs/ports-pending/x.txt': 'x\n',
      'ports-pending/x.txt': 'x\n',
      'ports-pending/unwired/bad.json': '[]',
    });
    const messages = ownershipFindings(dir).map(x => `${x.where}: ${x.message}`);
    for (const where of [
      'packages/plugins/alpha/ports-pending/Bad_Name.txt',
      'packages/plugins/alpha/ports-pending/note.md',
      'packages/plugins/alpha/ports-pending/empty.txt',
      'packages/plugins/alpha/ports-pending/two-lines.txt',
      'packages/plugins/alpha/ports-pending/halves/web.txt',
      'packages/plugins/alpha/ports-pending/elsewhere/x.txt',
      'packages/plugins/alpha/deeper/ports-pending/x.txt',
      'docs/ports-pending/x.txt',
      'ports-pending/x.txt',
      'ports-pending/unwired/bad.json',
    ])
      expect(messages.some(m => m.startsWith(`${where}:`))).toBe(true);
    expect(messages.some(m => m.startsWith('packages/plugins/alpha/ports-pending/fine.txt'))).toBe(false);
    expect(() => readPending(dir)).toThrow();
  });

  test('the retired single ports-pending.json is a finding, wherever it sits', async () => {
    const f = ws({ pending: ['alpha'] }, ['alpha']);
    f.write('packages/plugins/alpha/ports-pending.json', '{"format":1,"pending":["alpha"]}');
    f.write('ports-pending.json', '{"format":1}');
    const out = await found(f, 'file:/nonexistent');
    expect(out).toContain('packages/plugins/alpha/ports-pending.json: is the retired single ports-pending.json');
    expect(out).toContain('ports-pending.json: is the retired single ports-pending.json');
  });

  test('a skeleton half must be named under halves/, and a name for a real half fails', async () => {
    const f = ws({ pending: ['alpha'], pendingHalves: { alpha: ['daemon', 'app'] } }, ['alpha']);
    expect(await found(f, 'file:/nonexistent')).toContain(
      'cli half of alpha is a skeleton but ports-pending/halves/cli.txt',
    );
    const g = ws({ pending: ['alpha'], pendingHalves: { alpha: HALVES } }, ['alpha']);
    expect(await found(g, 'file:/nonexistent')).toBe('');
    g.write('packages/plugins/alpha/ports-pending/halves/app.txt', '');
  });

  test('a line kept by the wrong owner is a finding', () => {
    const messages = ownershipFindings(
      tree({
        'packages/plugins/beta/ports-pending/unwired/alpha-seam.json': JSON.stringify({
          seam: 'code:packages/plugins/alpha/daemon/index.ts:missing',
          card: '&F1',
          why: 'a gap',
        }),
        'ports-pending/unwired/alpha-in-root.json': JSON.stringify({
          seam: 'code:packages/plugins/alpha/daemon/index.ts:missing',
          card: '&F1',
          why: 'a gap',
        }),
        'packages/plugins/beta/ports-pending/app-ports/x.json': JSON.stringify({
          plugin: 'alpha',
          path: 'packages/plugins/alpha/app/x.tsx',
          reason: 'r',
        }),
      }),
    ).map(x => `${x.where}: ${x.message}`);
    expect(
      messages.some(
        m => m.startsWith('packages/plugins/beta/ports-pending/unwired/alpha-seam.json:') && m.includes('alpha'),
      ),
    ).toBe(true);
    expect(messages.some(m => m.startsWith('ports-pending/unwired/alpha-in-root.json:') && m.includes('alpha'))).toBe(
      true,
    );
    expect(
      messages.some(m => m.startsWith('packages/plugins/beta/ports-pending/app-ports/x.json:') && m.includes('alpha')),
    ).toBe(true);
  });

  const lists = {
    pending: ['alpha', 'beta'],
    pendingHalves: { alpha: HALVES, beta: HALVES },
    pendingReasons: { alpha: ['a1'], beta: ['b1', 'b2'] },
  };

  test('closing a line (deleting its file) is quiet; a plugin gaining a gap, or a half, fails', async () => {
    const base = ws(lists);
    const closed = ws({ pending: ['alpha'], pendingHalves: { alpha: HALVES }, pendingReasons: { alpha: ['a1'] } }, [
      'alpha',
    ]);
    expect(await found(closed, `file:${base.root}`)).toBe('');
    const betaOnly = ws({ pending: ['beta'], pendingHalves: { beta: HALVES }, pendingReasons: { beta: ['b1'] } }, [
      'alpha',
      'beta',
    ]);
    const added = ws(lists);
    expect(await found(added, `file:${betaOnly.root}`)).toContain('alpha gained a gap line; the list may only shrink');
    const fewerHalves = ws({ ...lists, pendingHalves: { alpha: ['app'], beta: HALVES } });
    expect(await found(added, `file:${fewerHalves.root}`)).toContain('pendingHalves alpha daemon was added');
  });

  test('git refs: a folder base and an old single-file base both answer the same merged document', () => {
    const modern = tree({
      ...gap('alpha', 'a1', '[own] a'),
      ...halves('alpha', ['app']),
      'ports-pending/unwired/hook-x.json': JSON.stringify({ seam: 'hook:x', card: '&F1', why: 'w' }),
    });
    git(modern, 'init', '-q');
    git(modern, 'add', '-A');
    git(modern, 'commit', '-q', '-m', 'base');
    const legacy = tree({
      'ports-pending.json': JSON.stringify({ format: 1, unwired: [{ seam: 'hook:x', card: '&F1', why: 'w' }] }),
      'packages/plugins/alpha/ports-pending.json': JSON.stringify({
        format: 1,
        pending: ['alpha'],
        pendingReasons: { alpha: ['[own] a'] },
        pendingHalves: { alpha: ['app'] },
      }),
      'packages/plugins/alpha/other.json': '{}',
    });
    git(legacy, 'init', '-q');
    git(legacy, 'add', '-A');
    git(legacy, 'commit', '-q', '-m', 'base');
    const shape = (dir: string): unknown => {
      const doc = JSON.parse(readPendingMergedBase(dir, 'HEAD') ?? '{}');
      return { pending: doc.pending, reasons: doc.pendingReasons, halves: doc.pendingHalves, unwired: doc.unwired };
    };
    expect(shape(legacy)).toEqual(shape(modern));
    expect(() => readPendingMergedBase(modern, 'no-such-ref')).toThrow();
    expect(readPendingMergedBase(tree({}), 'file:/nonexistent')).toBeUndefined();
  });

  test('a ledger file under a dot directory is found and rejected, not skipped', async () => {
    const f = ws({ pending: ['alpha'], pendingHalves: { alpha: HALVES } }, ['alpha']);
    f.write('.mistyped/ports-pending/ghost.txt', '[own] a hidden gap\n');
    expect(pendingFilePaths(f.root)).toContain('.mistyped/ports-pending/ghost.txt');
    const findings = await portsPending.run(contextFor(f.root, { base: 'file:/nonexistent' }));
    expect(
      findings.some(x => x.where === '.mistyped/ports-pending/ghost.txt' && x.message.includes('outside the rule')),
    ).toBe(true);
  });

  test('only metadata and dependency trees are skipped: .git, node_modules, .worktrees, .direnv', () => {
    const dir = tree({
      'ports-pending/unwired/a.json': '{}',
      '.git/ports-pending/x.txt': 'x\n',
      'node_modules/pkg/ports-pending/x.txt': 'x\n',
      '.worktrees/other/ports-pending/x.txt': 'x\n',
      '.direnv/ports-pending/x.txt': 'x\n',
      '.other/ports-pending/x.txt': 'x\n',
      'packages/plugins/alpha/node_modules/x/ports-pending/x.txt': 'x\n',
    });
    expect(pendingFilePaths(dir)).toEqual(['.other/ports-pending/x.txt', 'ports-pending/unwired/a.json']);
  });

  test('the gen tests’ own fixture folder is skipped by its path, and no other folder of that name is', () => {
    const dir = tree({
      'ports-pending/unwired/a.json': '{}',
      'scripts/gen/tests/.tmp/w1/packages/plugins/alpha/ports-pending/x.txt': 'x\n',
      'scripts/other/.tmp/ports-pending/x.txt': 'x\n',
      'scripts/gen/tests/ports-pending/x.txt': 'x\n',
    });
    expect(pendingFilePaths(dir)).toEqual([
      'ports-pending/unwired/a.json',
      'scripts/gen/tests/ports-pending/x.txt',
      'scripts/other/.tmp/ports-pending/x.txt',
    ]);
  });

  test('two branches that each close a neighbouring line merge clean (one file per line)', () => {
    const dir = tree({
      ...gap('alpha', 'one', '[own] one'),
      ...gap('alpha', 'two', '[own] two'),
      ...gap('alpha', 'three', '[own] three'),
      ...gap('alpha', 'four', '[own] four'),
    });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'a');
    git(dir, 'rm', '-q', 'packages/plugins/alpha/ports-pending/two.txt');
    git(dir, 'commit', '-q', '-m', 'close two');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'checkout', '-q', '-b', 'b');
    git(dir, 'rm', '-q', 'packages/plugins/alpha/ports-pending/three.txt');
    git(dir, 'commit', '-q', '-m', 'close three');
    git(dir, 'merge', '-q', '--no-edit', 'a');
    expect(readPendingMerged(dir)).toContain('[own] one');
    expect(readPending(dir).reasons).toEqual({ alpha: ['[own] four', '[own] one'] });
  });
});

describe('ownership of unwired seams', () => {
  const seam = (path: string): string => JSON.stringify({ seam: `code:${path}`, card: '&F1', why: 'a gap' });
  const alpha = 'packages/plugins/alpha/daemon/index.ts:missing';
  const messages = (files: Record<string, string>): string[] =>
    ownershipFindings(tree(files)).map(x => `${x.where}: ${x.message}`);

  test("alpha's code seam in its own folder, and a hook seam in the root, are clean", () => {
    expect(
      messages({
        'ports-pending/unwired/hook-card-moving.json': JSON.stringify({
          seam: 'hook:task.moving',
          card: '&F1',
          why: 'a hook',
        }),
        'packages/plugins/alpha/ports-pending/unwired/missing.json': seam(alpha),
      }),
    ).toEqual([]);
  });

  test('the real Accounts seam moved to the root is a finding', () => {
    const accounts = 'packages/plugins/accounts/daemon/index.ts:notBuiltRoute';
    expect(messages({ 'ports-pending/unwired/accounts.json': seam(accounts) }).length).toBeGreaterThan(0);
  });

  test('a malformed unwired entry is a finding, not a crash', () => {
    expect(
      messages({
        'packages/plugins/alpha/ports-pending/unwired/no-seam.json': '{"seam":3}',
        'packages/plugins/alpha/ports-pending/unwired/not-json.json': 'x',
      }).length,
    ).toBeGreaterThan(0);
  });
});
