import { describe, expect, test } from 'bun:test';
import { milliseconds } from '@ferretry/std';
import { bunSpawn } from '../../../host/adapters/process.ts';

const spawn = bunSpawn({ PATH: process.env.PATH ?? '/usr/bin:/bin' });

describe('kernel.spawn run answers how a child ended', () => {
  test('a child killed at its timeout has no exit code and names the signal', async () => {
    const result = await spawn.run('sleep', ['5'], { timeout: milliseconds(200) });
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGTERM');
  });

  test('a child ended by the abort signal has no exit code and names the signal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await spawn.run('sleep', ['5'], { signal: controller.signal });
    expect(result.exitCode).toBeNull();
    expect(result.signal).not.toBeNull();
  });

  test('a child that exits by itself answers its own code and no signal', async () => {
    const failed = await spawn.run('sh', ['-c', 'exit 3']);
    expect(failed.exitCode).toBe(3);
    expect(failed.signal).toBeNull();
    const fine = await spawn.run('printf', ['%s', 'ok']);
    expect(fine.exitCode).toBe(0);
    expect(fine.signal).toBeNull();
    expect(fine.stdout).toBe('ok');
  });

  test('a child that exits by itself with 143 answers that code and no signal', async () => {
    const result = await spawn.run('sh', ['-c', 'exit 143']);
    expect(result.exitCode).toBe(143);
    expect(result.signal).toBeNull();
  });
});
