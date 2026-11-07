import { describe, expect, it } from 'bun:test';
import type { SpawnPort } from '@ferretry/kernel/contract';
import { restrictSpawn } from '../../../../../core/kernel/host/permissions.ts';
import { darwinHost } from '../../../daemon/adapters/system/kernel-program-proof.ts';
import { programRunner } from '../../../daemon/adapters/terminal/system-login-shell.ts';
import { directoryServiceShell } from '../../../daemon/lib/terminal/login-shell.ts';
import manifest from '../../../manifest.ts';

function subject() {
  const calls: { program: string; args: readonly string[] }[] = [];
  const base: SpawnPort = {
    run: async (program, args) => {
      calls.push({ program, args });
      const stdout = program === 'lsof' ? '424242\n' : program === 'ps' ? '424242 ttys001\n' : 'UserShell: /bin/zsh\n';
      return { exitCode: 0, signal: null, stdout, stderr: '' };
    },
    runBytes: () => Promise.reject(new Error('the fixture runs no bytes')),
    start: () => {
      throw new Error('no child should be started');
    },
  };
  return { calls, run: programRunner(restrictSpawn(manifest.id, manifest.permissions.spawn, base)) };
}

describe('Terminals macOS programs with production spawn permissions', () => {
  it('allows lsof to prove the TTY is not held elsewhere', async () => {
    const { calls, run } = subject();

    expect(await darwinHost(run).heldElsewhere('/dev/ttys001')).toBe(false);
    expect(calls).toEqual([
      { program: 'lsof', args: ['-t', '--', '/dev/ttys001'] },
      { program: 'ps', args: ['-o', 'pid=,tty=', '-p', '424242'] },
    ]);
  });

  it('allows the absolute dscl program used to resolve the account login shell', async () => {
    const { calls, run } = subject();

    const output = await run(['/usr/bin/dscl', '.', '-read', '/Users/test-owner', 'UserShell']);

    expect(directoryServiceShell(output ?? '')).toBe('/bin/zsh');
    expect(calls).toEqual([{ program: '/usr/bin/dscl', args: ['.', '-read', '/Users/test-owner', 'UserShell'] }]);
  });
});
