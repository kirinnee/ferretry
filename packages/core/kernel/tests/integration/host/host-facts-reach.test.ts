/** What a descriptor reaches, and what a plugin that never declared host facts is refused. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeHostFacts, undeclaredHostFacts } from '../../../host/adapters/host-facts.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe('nodeHostFacts descriptor reach', () => {
  test('a descriptor that reaches a character device says so, with its device number; a plain file is not one', async () => {
    const root = await mkdtemp(`${tmpdir()}/fy-reach-`);
    roots.push(root);
    await mkdir(`${root}/42/fd`, { recursive: true });
    await symlink('/dev/null', `${root}/42/fd/0`);
    await writeFile(`${root}/plain`, 'x');
    await symlink(`${root}/plain`, `${root}/42/fd/1`);
    const facts = nodeHostFacts({ proc: root, sys: `${root}/sys` });
    const terminal = await facts.procFdReach(42, '0');
    expect(terminal.character).toBe(true);
    expect(terminal.device).toBeGreaterThan(0);
    expect((await facts.procFdReach(42, '1')).character).toBe(false);
    await expect(facts.procFdReach(42, '../x')).rejects.toBeInstanceOf(RangeError);
  });
});

describe('undeclaredHostFacts', () => {
  test('keeps the plain facts, refuses every read naming the plugin, and refuses the launch guard', async () => {
    const base = nodeHostFacts();
    const facts = undeclaredHostFacts('acme', base);
    expect(facts.platform).toBe(base.platform);
    expect(facts.cpus).toBe(base.cpus);
    expect(facts.totalMemoryBytes).toBe(base.totalMemoryBytes);
    expect(Object.isFrozen(facts)).toBe(true);
    await expect(facts.pids()).rejects.toThrow('acme did not declare permissions.hostFacts');
    await expect(facts.procFile(1, 'stat')).rejects.toThrow('permissions.hostFacts');
    await expect(facts.procFdReach(1, '0')).rejects.toThrow('permissions.hostFacts');
    await expect(facts.blockScheduler(8, 1)).rejects.toThrow('permissions.hostFacts');
    expect(() => facts.launchGuard()).toThrow(
      'acme did not declare permissions.hostFacts, so it reads no launch-guard fact.',
    );
  });
});
