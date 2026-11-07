/** OO: extra pipe fds for a child (Chrome's --remote-debugging-pipe on 3/4), its pid and stderr; a worker's exit seen. */
import { describe, expect, test } from 'bun:test';
import { read, write } from 'node:fs';
import { promisify } from 'node:util';
import { bunSpawn, bunWorkers } from '../../../host/adapters/process.ts';
import { restrictSpawn } from '../../../host/permissions.ts';

const readFd = promisify(read);
const writeFd = promisify(write);

describe('OO spawn: extra pipes, pid and stderr streaming; worker exit', () => {
  test('fds 3 and 4 are pipes the daemon holds the other end of; stderr streams; closePipes is once', async () => {
    const spawn = restrictSpawn('browsers', ['sh'], bunSpawn({ PATH: process.env.PATH ?? '/usr/bin:/bin' }));
    // the child echoes what it reads on fd 3 to fd 4, and says hello on stderr
    const child = spawn.start('sh', ['-c', 'echo hello >&2; head -c 4 <&3 >&4'], { extraPipes: 2 });
    expect(child.pid).toBeGreaterThan(0);
    expect(child.pipes).toHaveLength(2);
    const [toChild, fromChild] = child.pipes as [number, number];
    await writeFd(toChild, Buffer.from('ping'));
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await readFd(fromChild, buffer, 0, 4, null);
    expect(buffer.subarray(0, bytesRead).toString()).toBe('ping');
    expect(await new Response(child.stderr).text()).toBe('hello\n');
    expect(await child.exited).toBe(0);
    child.closePipes();
    child.closePipes();
  });

  test('no extra pipes means none, and an out-of-range count is refused', () => {
    const spawn = bunSpawn({ PATH: process.env.PATH ?? '/usr/bin:/bin' });
    const plain = spawn.start('true', []);
    expect(plain.pipes).toEqual([]);
    expect(() => spawn.start('true', [], { extraPipes: 5 })).toThrow(RangeError);
  });

  test('an undeclared program with extra pipes is still refused by restrictSpawn', () => {
    const spawn = restrictSpawn('browsers', ['chromium'], bunSpawn({}));
    expect(() => spawn.start('sh', [], { extraPipes: 2 })).toThrow();
  });

  test('a crashed worker reports its exit with a reason', async () => {
    const worker = bunWorkers().start(new URL('./fixtures/crash-worker.ts', import.meta.url));
    const exit = new Promise<{ code: number; reason?: string }>(resolve => worker.onExit(resolve));
    worker.post('go');
    const ended = await exit;
    expect(ended.code).not.toBe(0);
    expect(ended.reason ?? '').toContain('crashed on purpose');
  });
});
