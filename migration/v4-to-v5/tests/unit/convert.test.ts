import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { decideHome } from '@ferretry/kernel/contract';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convert } from '../../src/convert.ts';
import type { LockProbe } from '../../src/preflight.ts';
import { moveSealed } from '../../src/sealed.ts';
import type { Step } from '../../src/steps/index.ts';
import { pending, STEPS } from '../../src/steps/index.ts';

const notHeld: LockProbe = { held: async () => false };
const at = new Date('2026-11-07T01:00:00.000Z');
// A fixed fake marker, so a test can prove it never reaches a report. Not a real secret.
const PLANTED = 'PLANTED-SEALED-BYTES-0f3c9a';

let root: string;
let from: string;
let to: string;

async function v4Home(path: string): Promise<void> {
  await mkdir(join(path, 'state', 'sessions'), { recursive: true });
  await writeFile(join(path, 'layout-version'), '2\n', { mode: 0o600 });
  await writeFile(join(path, 'state', 'secrets.key'), PLANTED, { mode: 0o600 });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-v4-to-v5-'));
  from = join(root, 'v4');
  to = join(root, 'v5');
  await v4Home(from);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('preflight', () => {
  test('refuses a folder that is not a v4 layout-2 home', async () => {
    await writeFile(join(from, 'layout-version'), '1\n');
    const result = await convert({ from, to, dryRun: false, lock: notHeld, now: () => at });
    expect(result.kind).toBe('refused');
    expect(await stat(to).catch(() => undefined)).toBeUndefined();
  });

  test('refuses a v5 home as its source', async () => {
    await writeFile(join(from, 'home.json'), '{}');
    expect((await convert({ from, to, dryRun: false, lock: notHeld, now: () => at })).kind).toBe('refused');
  });

  test('refuses while the v4 daemon holds its lock', async () => {
    await writeFile(join(from, 'daemon.lock'), '');
    const held: LockProbe = { held: async () => true };
    const result = await convert({ from, to, dryRun: false, lock: held, now: () => at });
    expect(result.kind === 'refused' && result.problems.some(p => p.includes('still running'))).toBe(true);
  });

  test('refuses a target that is not empty, and one inside the source', async () => {
    await mkdir(to);
    await writeFile(join(to, 'x'), '');
    expect((await convert({ from, to, dryRun: false, lock: notHeld, now: () => at })).kind).toBe('refused');
    const nested = join(from, 'v5');
    expect((await convert({ from, to: nested, dryRun: false, lock: notHeld, now: () => at })).kind).toBe('refused');
  });
});

describe('conversion', () => {
  test('a pending step leaves no home.json, so v5 refuses the folder', async () => {
    const waiting = pending(
      { id: 'waits', title: 'A step whose v5 schema has not landed', owner: [], reads: [], sealed: [], notCarried: [] },
      'a test schema',
    );
    const result = await convert({ from, to, dryRun: false, lock: notHeld, now: () => at, steps: [...STEPS, waiting] });
    if (result.kind !== 'done') throw new Error('expected a run');
    expect(result.report.complete).toBe(false);
    expect(await readdir(to)).not.toContain('home.json');
    expect(decideHome(to, { kind: 'no-home-json' }).kind).toBe('refuse');
  });

  test('when every step converts, home.json is written last and v5 starts on it', async () => {
    const done: Step[] = STEPS.map(step => ({
      ...step,
      run: async () => ({ id: step.id, title: step.title, status: 'converted', kept: [], notCarried: [], sealed: [] }),
    }));
    const result = await convert({ from, to, dryRun: false, lock: notHeld, now: () => at, steps: done });
    if (result.kind !== 'done') throw new Error('expected a run');
    expect(result.report.complete).toBe(true);
    const text = await readFile(join(to, 'home.json'), 'utf8');
    expect(decideHome(to, { kind: 'home-json', text }).kind).toBe('start');
    expect((await stat(to)).mode & 0o777).toBe(0o700);
  });

  test('the v4 home is never written', async () => {
    // Recursive readdir order is not stable across calls: compare the sets of names.
    const before = (await readdir(from, { recursive: true })).sort();
    await convert({ from, to, dryRun: false, lock: notHeld, now: () => at });
    expect((await readdir(from, { recursive: true })).sort()).toEqual(before);
  });

  test('every step reports, in the owner’s order of importance', async () => {
    const result = await convert({ from, to, dryRun: true, lock: notHeld, now: () => at });
    if (result.kind !== 'done') throw new Error('expected a run');
    expect(result.report.steps.map(s => s.id).slice(0, 4)).toEqual([
      'ferrets',
      'conversation',
      'terminals',
      'harness-homes',
    ]);
    expect(await stat(to).catch(() => undefined)).toBeUndefined();
  });
});

describe('sealed files', () => {
  test('are moved byte for byte with their mode, and never reach the report', async () => {
    await chmod(join(from, 'state', 'secrets.key'), 0o400);
    const target = join(to, 'state', 'vault', 'vault.key');
    const moved = await moveSealed(join(from, 'state', 'secrets.key'), target);
    expect(moved.bytes).toBe(PLANTED.length);
    expect((await stat(target)).mode & 0o777).toBe(0o400);
    // Comparing the copy is the test's job, not the tool's: the tool itself never reads the bytes.
    expect(await readFile(target, 'utf8')).toBe(PLANTED);
    expect(JSON.stringify(moved)).not.toContain(PLANTED);
  });

  test('refuse to overwrite and refuse a symlink source', async () => {
    const target = join(root, 'out.key');
    await moveSealed(join(from, 'state', 'secrets.key'), target);
    await expect(moveSealed(join(from, 'state', 'secrets.key'), target)).rejects.toThrow();
    const { symlink } = await import('node:fs/promises');
    await symlink(join(from, 'state', 'secrets.key'), join(root, 'link.key'));
    await expect(moveSealed(join(root, 'link.key'), join(root, 'other.key'))).rejects.toThrow('not a regular file');
  });
});
