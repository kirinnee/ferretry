/**
 * RULE D at the OUTPUT boundaries: the new home's parent and the report's parent. A person may spell either through a
 * system link (macOS `/tmp` -> `/private/tmp`, `/var`, `/etc`), so a link ABOVE the output is not refused outright:
 * the parent is resolved ONCE, every write goes to the resolved place, and every component from the resolved parent
 * down is `lstat`ed again at write time, so a link swapped in AFTER the resolve refuses. A system link is simulated with
 * a temp-dir link. Temp folders and fake bytes only.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { lstat, mkdir, readdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { convert } from '../../src/convert.ts';
import type { LockProbe } from '../../src/preflight.ts';
import { resolveReport, writeReportFile } from '../../src/report-file.ts';
import type { Step } from '../../src/steps/index.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
let outside = '';
beforeEach(async () => {
  f = await fixture();
  outside = join(f.root, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
});
afterEach(async () => f.clean());

const notHeld: LockProbe = { held: async () => false };
const run = (to: string, steps: readonly Step[] = []) =>
  convert({ from: f.from, to, dryRun: false, lock: notHeld, now: () => new Date(), steps });

/** A step that swaps a folder for a link AFTER preflight, then tries one ordinary write. */
const swapThenWrite = (swap: () => Promise<void>): Step => ({
  id: 'swap',
  title: 'swap',
  owner: [],
  reads: [],
  sealed: [],
  notCarried: [],
  async run(ctx) {
    await swap();
    try {
      await ctx.v5.json({ path: 'state/x/doc.json', format: 1, schema: z.object({ a: z.number() }) }, { a: 1 });
      return { id: 'swap', title: 'swap', status: 'converted', kept: [], notCarried: [], sealed: [] };
    } catch (error) {
      const note = error instanceof Error ? error.message : 'threw';
      return { id: 'swap', title: 'swap', status: 'failed', note, kept: [], notCarried: [], sealed: [] };
    }
  },
});

test('a home spelled through a system-style link made BEFORE the run converts to the resolved place', async () => {
  const parent = join(f.root, 'tmp-alias');
  await symlink(outside, parent);
  const result = await run(join(parent, 'v5'));
  const resolved = join(await realpath(outside), 'v5');
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') return;
  expect(result.report.complete).toBe(true);
  expect(result.report.to).toBe(resolved);
  expect((await lstat(join(resolved, 'home.json'))).isFile()).toBe(true);
  expect(await readdir(outside)).toEqual(['v5']);
});

test('a link swapped in ABOVE the new home after preflight refuses, and nothing is written through it', async () => {
  const deep = join(f.root, 'deep');
  const real = join(f.root, 'deep-real');
  await mkdir(join(outside, 'v5'), { recursive: true, mode: 0o700 });
  const result = await run(join(deep, 'v5'), [
    swapThenWrite(async () => {
      await rename(deep, real);
      await symlink(outside, deep);
    }),
  ]);
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') return;
  expect(result.report.steps[0]?.status).toBe('failed');
  expect(result.report.steps[0]?.note).toContain(`${deep} is a link, so nothing was written through it`);
  expect(result.report.complete).toBe(false);
  expect(await readdir(join(outside, 'v5'))).toEqual([]);
  await expect(lstat(join(real, 'v5', 'home.json'))).rejects.toThrow();
});

test('a link swapped in at the new home itself after preflight refuses before home.json is written', async () => {
  const result = await run(f.to, [
    swapThenWrite(async () => {
      await rename(f.to, `${f.to}-real`);
      await symlink(outside, f.to);
    }),
  ]);
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') return;
  expect(result.report.steps[0]?.status).toBe('failed');
  expect(result.report.complete).toBe(false);
  expect(await readdir(outside)).toEqual([]);
});

test('a final-component link at the new home still refuses before the run', async () => {
  await symlink(outside, f.to);
  const result = await run(f.to);
  expect(result.kind).toBe('refused');
  expect(result.kind === 'refused' ? result.problems.join('\n') : '').toContain(`${f.to} is a link`);
  expect(await readdir(outside)).toEqual([]);
});

test('the report: its parent is resolved once and written against; a link swapped in after the resolve refuses', async () => {
  const parent = join(f.root, 'report-parent');
  await mkdir(parent, { mode: 0o700 });
  await writeFile(join(outside, 'report.json'), 'FAKE-PRECIOUS-KEEP');
  const wanted = await resolveReport(join(parent, 'report.json'));
  expect(wanted.problem).toBeUndefined();
  await rename(parent, `${parent}-real`);
  await symlink(outside, parent);
  const written = await writeReportFile(wanted.place, '{}\n');
  expect(written.problem).toContain(`${parent} is a link`);
  expect(await readFile(join(outside, 'report.json'), 'utf8')).toBe('FAKE-PRECIOUS-KEEP');
});

test('the report: a final-component link refuses, before and at write time, and the target is never touched', async () => {
  await writeFile(join(outside, 'report.json'), 'FAKE-PRECIOUS-KEEP');
  const path = join(f.root, 'report.json');
  await symlink(join(outside, 'report.json'), path);
  const wanted = await resolveReport(path);
  expect(wanted.problem).toContain(`${path} is a link`);
  expect(wanted.problem).not.toContain(outside);
  expect((await writeReportFile(wanted.place, '{}\n')).problem).toContain(`${path} is a link`);
  expect(await readFile(join(outside, 'report.json'), 'utf8')).toBe('FAKE-PRECIOUS-KEEP');
});

const main = async (args: readonly string[]) => {
  const userHome = join(f.root, 'fake-home');
  await mkdir(userHome, { recursive: true });
  const child = Bun.spawn(['bun', join(import.meta.dir, '../../src/main.ts'), ...args], {
    env: { ...process.env, HOME: userHome, XDG_CONFIG_HOME: join(userHome, '.config') },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
};

test('main: a report path spelled through a link made before the run is written at the resolved place, and says so', async () => {
  const alias = join(f.root, 'tmp-alias');
  await symlink(outside, alias);
  const { code, out } = await main(['--from', f.from, '--to', f.to, '--report', join(alias, 'report.json')]);
  const resolved = join(await realpath(outside), 'report.json');
  expect(code).toBe(0);
  expect(out).toContain(`report: ${resolved}`);
  expect(out).toContain(`new home: ${f.to}`);
  expect(JSON.parse(await readFile(resolved, 'utf8')).complete).toBe(true);
});

test('main: a report path that is itself a link refuses before anything is written', async () => {
  await writeFile(join(outside, 'report.json'), 'FAKE-PRECIOUS-KEEP');
  const path = join(f.root, 'report.json');
  await symlink(join(outside, 'report.json'), path);
  const { code, err } = await main(['--from', f.from, '--to', f.to, '--report', path]);
  expect(code).toBe(2);
  expect(err).toContain(`${path} is a link`);
  expect(await readFile(join(outside, 'report.json'), 'utf8')).toBe('FAKE-PRECIOUS-KEEP');
  await expect(lstat(f.to)).rejects.toThrow();
  expect(dirname(path)).toBe(f.root);
});
