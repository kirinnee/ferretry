import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The fixture builder's refusal guard. A refusal happens BEFORE anything is created or started (no daemon, no tmux),
 * so this is safe to run anywhere: the builder is run only down its refusal path.
 */
const BUILDER = resolve(import.meta.dir, '../../fixtures/build-v4-home.ts');

async function build(args: readonly string[]): Promise<{ code: number; err: string }> {
  const child = Bun.spawn(['bun', BUILDER, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { code, err };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-fixture-guard-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('build-v4-home refusals', () => {
  test('usage without --out is 64', async () => {
    expect((await build([])).code).toBe(64);
  });

  test('a folder outside the OS temp dir is refused and not created', async () => {
    const outside = join(homedir(), `.fy-fixture-guard-never-${Date.now()}`);
    const ran = await build(['--out', outside, '--v4-dir', root]);
    expect(ran.code).toBe(2);
    expect(ran.err).toContain('not under the OS temp dir');
    // Nothing was created where it refused.
    expect(await Bun.file(outside).exists()).toBe(false);
  });

  test('a non-empty folder under the temp dir is refused and left as it was', async () => {
    const full = join(root, 'full');
    await mkdir(full);
    await writeFile(join(full, 'keep.txt'), 'keep');
    const ran = await build(['--out', full, '--v4-dir', root]);
    expect(ran.code).toBe(2);
    expect(ran.err).toContain('is not empty');
    expect(await readdir(full)).toEqual(['keep.txt']);
  });
});
