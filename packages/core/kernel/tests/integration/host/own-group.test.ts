/** OO spawn: `ownGroup` makes a child's kill reach every process it started, with its stdio still piped. */
import { describe, expect, test } from 'bun:test';
import { bunSpawn } from '../../../host/adapters/process.ts';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

/** Starts `sh` with a background `sleep`, and answers the sleep's pid from the child's own stdout. */
async function startWithGrandchild(ownGroup: boolean) {
  const spawn = bunSpawn({ PATH: process.env.PATH ?? '/usr/bin:/bin' });
  const child = spawn.start('sh', ['-c', 'sleep 60 & echo $!; wait'], ownGroup ? { ownGroup: true } : {});
  const reader = child.stdout.getReader();
  const first = await reader.read();
  const pid = Number(new TextDecoder().decode(first.value).trim());
  expect(pid).toBeGreaterThan(1);
  return { child, pid };
}

describe('OO spawn: ownGroup', () => {
  test('kill reaches the grandchildren, and the piped output was still read', async () => {
    const { child, pid } = await startWithGrandchild(true);
    child.kill('SIGKILL');
    await child.exited;
    expect(await gone(pid)).toBe(true);
  });

  test('without it a kill reaches only the child (the control), which is why the option exists', async () => {
    const { child, pid } = await startWithGrandchild(false);
    child.kill('SIGKILL');
    await child.exited;
    expect(alive(pid)).toBe(true);
    process.kill(pid, 'SIGKILL');
    expect(await gone(pid)).toBe(true);
  });

  test('a kill after the child already exited is harmless', async () => {
    const spawn = bunSpawn({ PATH: process.env.PATH ?? '/usr/bin:/bin' });
    const child = spawn.start('true', [], { ownGroup: true });
    await child.exited;
    expect(() => child.kill('SIGKILL')).not.toThrow();
  });
});
