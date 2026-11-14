/**
 * RULE D: no WRITE through a link. Every path the converter writes or creates in the new home has each component
 * `lstat`ed first, and a link anywhere on it refuses, writing nothing through it. Temp folders only.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { convert } from '../../src/convert.ts';
import type { LockProbe } from '../../src/preflight.ts';
import { loginsStep } from '../../src/steps/logins.ts';
import type { Step } from '../../src/steps/index.ts';
import { LinkOnWritePathError, refuseLinkOnPath } from '../../src/v5/no-link.ts';
import { v5Writer } from '../../src/v5/write.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
let elsewhere = '';
beforeEach(async () => {
  f = await fixture();
  elsewhere = join(f.root, 'elsewhere');
  await mkdir(elsewhere, { mode: 0o700 });
});
afterEach(async () => f.clean());

const DEF = { path: 'state/x/doc.json', format: 1, schema: z.object({ a: z.number() }) };
const notHeld: LockProbe = { held: async () => false };
const refuses = (link: string): string => `${link} is a link, so nothing was written through it`;

test('a folder on the way to a v5 output path that is a link refuses, and writes nothing through it', async () => {
  await mkdir(f.to, { mode: 0o700 });
  await symlink(elsewhere, join(f.to, 'state'));
  const writer = v5Writer(f.to, { dryRun: false });
  await expect(writer.json(DEF, { a: 1 })).rejects.toThrow(refuses(join(f.to, 'state')));
  await expect(writer.opaque('state/y/blob', 'x')).rejects.toBeInstanceOf(LinkOnWritePathError);
  expect(() => writer.resolve('state/deep/er/file')).toThrow(LinkOnWritePathError);
  expect(await readdir(elsewhere)).toEqual([]);
});

test('a link deeper down the path refuses too, and so does the final component', async () => {
  await mkdir(join(f.to, 'config'), { recursive: true, mode: 0o700 });
  await symlink(elsewhere, join(f.to, 'config/logins'));
  const writer = v5Writer(f.to, { dryRun: false });
  expect(() => writer.resolve('config/logins/one.yaml')).toThrow(refuses(join(f.to, 'config/logins')));
  await mkdir(join(f.to, 'state'), { mode: 0o700 });
  await writeFile(join(elsewhere, 'target.json'), '{"keep":true}');
  await symlink(join(elsewhere, 'target.json'), join(f.to, 'state/doc.json'));
  await expect(writer.json({ ...DEF, path: 'state/doc.json' }, { a: 1 })).rejects.toThrow(LinkOnWritePathError);
  expect(await readFile(join(elsewhere, 'target.json'), 'utf8')).toBe('{"keep":true}');
});

test('the new home itself being a link refuses; a real home and a not-yet-existing path are fine', async () => {
  const linked = join(f.root, 'linked-home');
  await symlink(elsewhere, linked);
  expect(() => v5Writer(linked, { dryRun: false }).resolve('state/x')).toThrow(refuses(linked));
  await mkdir(f.to, { mode: 0o700 });
  const writer = v5Writer(f.to, { dryRun: false });
  await writer.json(DEF, { a: 1 });
  expect(JSON.parse(await readFile(join(f.to, DEF.path), 'utf8'))).toEqual({ a: 1 });
  expect(() => refuseLinkOnPath(f.to, join(f.to, 'never/made/yet'))).not.toThrow();
});

test('a dry run refuses a planted link on an output path as well (the plan must match the run)', async () => {
  await mkdir(f.to, { mode: 0o700 });
  await symlink(elsewhere, join(f.to, 'state'));
  expect(() => v5Writer(f.to, { dryRun: true }).resolve('state/x')).toThrow(LinkOnWritePathError);
});

test('the conversion REFUSES, before writing, when the new home is a link (even to an empty folder)', async () => {
  await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
  await symlink(elsewhere, f.to);
  const result = await convert({ from: f.from, to: f.to, dryRun: false, lock: notHeld, now: () => new Date() });
  expect(result.kind).toBe('refused');
  const text = result.kind === 'refused' ? result.problems.join('\n') : '';
  expect(text).toContain(`${f.to} is a link, so the conversion did not start`);
  expect(text).toContain('then run again');
  expect(text).not.toContain(elsewhere);
  expect(await readdir(elsewhere)).toEqual([]);
});

test('a link planted on a v5 output path DURING the run fails the step and writes nothing through it', async () => {
  await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
  const planter: Step = {
    id: 'planter',
    title: 'planter',
    owner: [],
    reads: [],
    sealed: [],
    notCarried: [],
    async run(ctx) {
      // Something else makes a link at a v5 output path after the folder exists.
      await mkdir(ctx.v5.resolve('state'), { recursive: true, mode: 0o700 });
      await symlink(elsewhere, ctx.v5.resolve('state/kernel'));
      try {
        await ctx.v5.json({ path: 'state/kernel/doc.json', format: 1, schema: z.object({ a: z.number() }) }, { a: 1 });
        return { id: 'planter', title: 'planter', status: 'converted', kept: [], notCarried: [], sealed: [] };
      } catch (error) {
        return {
          id: 'planter',
          title: 'planter',
          status: 'failed',
          note: error instanceof Error ? error.message : 'threw',
          kept: [],
          notCarried: [],
          sealed: [],
        };
      }
    },
  };
  const result = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: notHeld,
    now: () => new Date(),
    steps: [planter],
  });
  expect(result.kind).toBe('done');
  const step = result.kind === 'done' ? result.report.steps[0] : undefined;
  expect(step?.status).toBe('failed');
  expect(step?.note).toContain(`${join(f.to, 'state/kernel')} is a link, so nothing was written through it`);
  expect(result.kind === 'done' ? result.report.complete : true).toBe(false);
  expect(await readdir(elsewhere)).toEqual([]);
  // home.json is last and only for a finished run.
  await expect(lstat(join(f.to, 'home.json'))).rejects.toThrow();
});

test('a sealed-tree or credentials write below a v5 folder that is a link fails the Logins step, nothing written through it', async () => {
  await mkdir(join(f.from, 'fleet/credentials/work'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.from, 'fleet/credentials/work/.credentials.json'), 'FAKE', { mode: 0o600 });
  await mkdir(join(f.to, 'state/logins'), { recursive: true, mode: 0o700 });
  await symlink(elsewhere, join(f.to, 'state/logins/credentials'));
  const report = await loginsStep
    .run({ ...f.ctx(), host: { homeDirectory: join(f.root, 'nohome'), env: {} } })
    .catch((error: unknown) => ({ status: 'threw', note: error instanceof Error ? error.message : '' }));
  expect(report.status === 'failed' || report.status === 'threw').toBe(true);
  expect(await readdir(elsewhere)).toEqual([]);
});

test('main refuses a report path that is a link, before anything is written', async () => {
  await writeFile(join(f.from, 'layout-version'), '2\n', { mode: 0o600 });
  const report = join(f.root, 'report.json');
  await writeFile(join(elsewhere, 'precious.json'), 'KEEP');
  await symlink(join(elsewhere, 'precious.json'), report);
  const run = Bun.spawn(
    ['bun', join(import.meta.dir, '../../src/main.ts'), '--from', f.from, '--to', f.to, '--report', report],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, err] = [await run.exited, await new Response(run.stderr).text()];
  expect(code).toBe(2);
  expect(err).toContain(`${report} is a link`);
  expect(await readFile(join(elsewhere, 'precious.json'), 'utf8')).toBe('KEEP');
  await expect(lstat(f.to)).rejects.toThrow();
});
