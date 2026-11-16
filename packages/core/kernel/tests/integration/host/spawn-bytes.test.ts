import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { milliseconds } from '@ferretry/std';
import type { PinnedWorkingDirectory } from '../../../contract/pinned.ts';
import { bunSpawn } from '../../../host/adapters/process.ts';

const spawn = bunSpawn({ PATH: process.env.PATH ?? '/usr/bin:/bin' });

describe('kernel.spawn runBytes (today’s Git runner capture)', () => {
  test('stdout comes back as bytes, cut at maxStdoutBytes and marked truncated', async () => {
    const whole = await spawn.runBytes('printf', ['\\x00\\xff%s', 'abcdef']);
    expect([...whole.stdout.slice(0, 2)]).toEqual([0, 255]);
    expect(whole.stdoutTruncated).toBe(false);
    expect(whole.exitCode).toBe(0);
    const cut = await spawn.runBytes('printf', ['%s', 'abcdef'], { maxStdoutBytes: 3 });
    expect(new TextDecoder().decode(cut.stdout)).toBe('abc');
    expect(cut.stdoutTruncated).toBe(true);
  });

  test('a timeout kills the child and answers timedOut with exit -1', async () => {
    const slow = await spawn.runBytes('sleep', ['5'], { timeout: milliseconds(100) });
    expect(slow.timedOut).toBe(true);
    expect(slow.exitCode).toBe(-1);
  });

  test('a pinned cwd is installed for the spawn and undone straight after', async () => {
    const dir = await realpath(await mkdtemp(`${tmpdir()}/fy-spawn-`));
    const before = process.cwd();
    const calls: string[] = [];
    const pin: PinnedWorkingDirectory = {
      describe: dir,
      install: () => {
        calls.push('install');
        process.chdir(dir);
        return () => {
          calls.push('undo');
          process.chdir(before);
        };
      },
    };
    try {
      const result = await spawn.runBytes('pwd', [], { cwd: pin });
      expect(new TextDecoder().decode(result.stdout).trim()).toBe(dir);
      expect(calls).toEqual(['install', 'undo']);
      expect(process.cwd()).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
