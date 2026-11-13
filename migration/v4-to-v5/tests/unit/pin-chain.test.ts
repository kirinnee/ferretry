/**
 * The folders above an output are pinned (identity, every component from `/` down to the resolved anchor). A component
 * that is DETECTED as a link, a non-folder or unreadable while pinning REFUSES: the pin chain is whole or the run
 * writes nothing. It never comes back empty (an empty chain verified nothing, so a report could overwrite a file
 * outside). Temp folders and fake bytes only; the link is made by hooking `lstat` so it appears at the instant the chain
 * is looked at.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinkOnWritePathError } from '../../src/v5/no-link.ts';

const real = { ...fs };
/** Runs before every `lstat` of the pinning walk; the tests use it to swap a folder for a link at that instant. */
let duringLstat: ((path: string) => Promise<void>) | undefined;
mock.module('node:fs/promises', () => ({
  ...real,
  async lstat(path: unknown, ...args: unknown[]) {
    await duringLstat?.(String(path));
    return (real.lstat as (...all: unknown[]) => unknown)(path, ...args);
  },
}));
const { resolveReport, writeReportFile } = await import('../../src/report-file.ts');
const { convert } = await import('../../src/convert.ts');
const { resolvePlace } = await import('../../src/v5/resolved-place.ts');

let root = '';
let outer = '';
let outside = '';
beforeEach(async () => {
  root = await real.mkdtemp(join(tmpdir(), 'fy-pin-'));
  outer = join(root, 'outer');
  outside = join(root, 'outside');
  await real.mkdir(join(outer, 'parent'), { recursive: true });
  await real.mkdir(join(outside, 'parent'), { recursive: true });
});
afterEach(async () => {
  duringLstat = undefined;
  await real.rm(root, { recursive: true, force: true });
});

/** Swaps `outer` for a link to `outside` the first time the pinning walk looks at it. */
function linkAppearsAt(path: string): { readonly detected: () => boolean } {
  let done = false;
  duringLstat = async seen => {
    if (seen !== path || done) return;
    done = true;
    await real.rename(path, `${path}-saved`);
    await real.symlink(outside, path);
  };
  return { detected: () => done };
}

test('a link detected while pinning refuses the report: nothing is written through it', async () => {
  const target = join(outside, 'parent/report.json');
  await real.writeFile(target, 'FAKE-PRECIOUS-KEEP');
  const race = linkAppearsAt(outer);
  const wanted = await resolveReport(join(outer, 'parent/report.json'));
  duringLstat = undefined;
  expect(race.detected()).toBe(true);
  // Refused up front: there is no place to write at, so the caller cannot write.
  expect(wanted.problem).toBeDefined();
  expect(wanted.place).toBeUndefined();
  expect(wanted.problem).toContain(outer);
  expect(wanted.problem).not.toContain(outside);
  expect(await real.readFile(target, 'utf8')).toBe('FAKE-PRECIOUS-KEEP');
});

test('a link detected while pinning refuses the new home: nothing is written, the link is named, not its target', async () => {
  const race = linkAppearsAt(outer);
  const from = join(root, 'v4');
  await real.mkdir(from, { mode: 0o700 });
  await real.writeFile(join(from, 'layout-version'), '2\n');
  const result = await convert({
    from,
    to: join(outer, 'parent/v5'),
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date(),
    steps: [],
  });
  duringLstat = undefined;
  expect(race.detected()).toBe(true);
  expect(result.kind).toBe('refused');
  if (result.kind !== 'refused') return;
  const said = result.problems.join('\n');
  expect(said).toContain(outer);
  expect(said).not.toContain(outside);
  expect(await real.readdir(join(outside, 'parent'))).toEqual([]);
});

test('resolvePlace throws the link refusal when a link is detected while pinning, never an empty chain', async () => {
  linkAppearsAt(outer);
  const error = await resolvePlace(join(outer, 'parent/v5')).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  duringLstat = undefined;
  expect(error).toBeInstanceOf(LinkOnWritePathError);
  expect((error as LinkOnWritePathError).link).toBe(outer);
  expect((error as LinkOnWritePathError).reason).toBe('link');
  expect((error as LinkOnWritePathError).message).not.toContain(outside);
});

test('a non-folder in the chain refuses (the report and the new home), and nothing is written', async () => {
  const file = join(root, 'a-file');
  await real.writeFile(file, 'FAKE-FILE');
  const wanted = await resolveReport(join(file, 'report.json'));
  expect(wanted.problem).toBeDefined();
  expect(wanted.place).toBeUndefined();
  expect(wanted.problem).toContain(file);

  const from = join(root, 'v4');
  await real.mkdir(from, { mode: 0o700 });
  await real.writeFile(join(from, 'layout-version'), '2\n');
  const result = await convert({
    from,
    to: join(file, 'v5'),
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date(),
    steps: [],
  });
  expect(result.kind).toBe('refused');
  expect(await real.readFile(file, 'utf8')).toBe('FAKE-FILE');
});

test('a chain with no link still pins whole and writes the report', async () => {
  const wanted = await resolveReport(join(outer, 'parent/report.json'));
  expect(wanted.problem).toBeUndefined();
  if (wanted.place === undefined) throw new Error('expected a place');
  expect(wanted.place.pins.length).toBeGreaterThan(1);
  expect(await writeReportFile(wanted.place, 'FAKE-REPORT')).toEqual({});
  expect(await real.readFile(join(outer, 'parent/report.json'), 'utf8')).toBe('FAKE-REPORT');
});
