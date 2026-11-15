import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, makeSandbox, type Sandbox } from './migrate-harness.ts';

/**
 * Proof run 6: a tool missing from the machine (`comm`) was found at `verify`, after the backup. `preflight` now checks every
 * external tool a later phase calls, so the run stops there, and says which. And `start` says out loud that its
 * `fy config check` ran and passed (it ran silently before).
 */

setDefaultTimeout(60_000);

// The tools `preflight` requires (migrate.sh, the `for tool in` loop). The fakes (tmux, bun, ...) come from the sandbox's own bin.
const REAL_TOOLS = [
  'bash',
  'jq',
  'git',
  'awk',
  'basename',
  'cat',
  'chmod',
  'cmp',
  'comm',
  'cp',
  'date',
  'df',
  'dirname',
  'du',
  'env',
  'find',
  'grep',
  'ls',
  'mkdir',
  'mktemp',
  'mv',
  'rm',
  'sed',
  'sort',
  'tail',
  'tr',
  'uname',
  'wc',
] as const;

const made: Sandbox[] = [];
const box = async (): Promise<Sandbox> => {
  const sb = await makeSandbox();
  made.push(sb);
  return sb;
};
afterEach(async () => {
  await Promise.all(made.splice(0).map(sb => sb.cleanup()));
});

/** A PATH holding the sandbox's fakes and exactly the real tools above, minus `without`. */
const pathWithout = async (sb: Sandbox, without?: string): Promise<string> => {
  const bin = join(sb.root, 'realbin');
  await mkdir(bin, { recursive: true });
  for (const tool of REAL_TOOLS) {
    if (tool === without) continue;
    const real = Bun.which(tool);
    if (real === null) throw new Error(`this machine has no ${tool}`);
    await symlink(real, join(bin, tool));
  }
  // `sleep` and `ps` are fakes in the sandbox; the script's own `command -v sleep` is answered by that fake.
  return `${join(sb.root, 'fakebin')}:${bin}`;
};

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('preflight checks every external tool a later phase calls', () => {
  test('a machine with every tool passes (the control for the test below)', async () => {
    const sb = await box();
    const result = await sb.run('preflight', ['--notes', sb.notes], { PATH: await pathWithout(sb) });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
  });

  test('`comm` missing: preflight refuses, names comm, and touches nothing', async () => {
    const sb = await box();
    const result = await sb.run('preflight', ['--notes', sb.notes], { PATH: await pathWithout(sb, 'comm') });
    expect(result.code).toBe(1);
    expect(result.err).toContain('not on PATH: comm');
    expect(result.err.trim().split('\n')).toHaveLength(1);
    expect(await exists(sb.notes)).toBe(false);
    expect((await sb.calls()).filter(line => /^(tmux|fy|fyd|brew|nix) /.test(line))).toEqual([]);
  });

  test('two tools missing are both named', async () => {
    const sb = await box();
    const path = await pathWithout(sb, 'comm');
    await Bun.spawn(['rm', join(sb.root, 'realbin', 'sort')]).exited;
    const result = await sb.run('preflight', ['--notes', sb.notes], { PATH: path });
    expect(result.code).toBe(1);
    expect(result.err).toContain('not on PATH: comm, sort');
  });
});

describe('start says its config check ran and passed', () => {
  test('a clean check prints one line saying so', async () => {
    const sb = await box();
    await advance(sb, 'install');
    const result = await sb.run('start');
    expect(result.code).toBe(0);
    expect(result.out).toContain('fy config check ran against the v5 daemon and passed');
    expect(result.out.split('\n').filter(line => line.includes('fy config check ran'))).toHaveLength(1);
  });
});
