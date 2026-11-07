import { describe, expect, test } from 'bun:test';
import type { KernelPorts, RootHandle, SpawnResult } from '@ferretry/kernel/contract';
import { kernelFolders } from '../../../daemon/adapters/folders.ts';

type Call = { program: string; args: readonly string[]; env?: unknown };

function machine(answer: (call: Call) => Partial<SpawnResult> | 'throw', directories: readonly string[] = []) {
  const calls: Call[] = [];
  const kernel = {
    spawn: {
      run: async (program: string, args: readonly string[], options?: { env?: unknown }) => {
        const call = { program, args, env: options?.env };
        calls.push(call);
        const out = answer(call);
        if (out === 'throw') throw new Error('Executable not found in $PATH');
        return { exitCode: 0, signal: null, stdout: '', stderr: '', ...out } as SpawnResult;
      },
    },
    roots: {
      root: (_name: string, scope?: { subfolder?: string }) =>
        ({
          resolve: (relative: string) => ({ ok: true, value: `${scope?.subfolder ?? ''}${relative}` }),
          stat: async (path: string) => (directories.includes(path) ? { kind: 'directory' } : undefined),
        }) as unknown as RootHandle,
    },
  } as unknown as Pick<KernelPorts, 'roots' | 'spawn'>;
  return { folders: kernelFolders(kernel), calls };
}

describe('kernelFolders', () => {
  test('a directory is one the imports root can stat as a directory; anything else is not', async () => {
    const { folders } = machine(() => ({}), ['/work/there']);
    expect(await folders.isDirectory('/work/there')).toBe(true);
    expect(await folders.isDirectory('/work/absent')).toBe(false);
  });

  test('a folder that is a work tree is resolved through git, including the prefix of a subfolder', async () => {
    const { folders } = machine(call =>
      call.args.includes('--show-toplevel') ? { stdout: '/real/repo\nsub/dir/\n' } : {},
    );
    expect(await folders.canonical('/link/repo/sub/dir')).toBe('/real/repo/sub/dir');
  });

  test('a folder that git does not know is taken as given; so is a host without git', async () => {
    expect(await machine(() => ({ exitCode: 128 })).folders.canonical('/work/plain')).toBe('/work/plain');
    expect(await machine(() => 'throw').folders.canonical('/work/plain')).toBe('/work/plain');
  });

  test('the common directory is git’s absolute answer, else the relative one resolved against the root', async () => {
    const absolute = machine(() => ({ stdout: '/work/repo/.git\n' }));
    expect(await absolute.folders.gitCommonDirectory('/work/repo')).toBe('/work/repo/.git');
    const older = machine(call =>
      call.args.includes('--path-format=absolute') ? { exitCode: 129 } : { stdout: '.git\n' },
    );
    expect(await older.folders.gitCommonDirectory('/work/repo')).toBe('/work/repo/.git');
    expect(await machine(() => ({ exitCode: 128 })).folders.gitCommonDirectory('/work/plain')).toBeUndefined();
    expect(await machine(() => 'throw').folders.gitCommonDirectory('/work/plain')).toBeUndefined();
  });

  test('a clone hands git only the transports the address schema allows, and a failure says which git step', async () => {
    const ok = machine(() => ({}));
    await ok.folders.gitClone('https://host/r.git', '/work/r');
    expect(ok.calls[0]).toEqual({
      program: 'git',
      args: ['clone', '--', 'https://host/r.git', '/work/r'],
      env: { GIT_ALLOW_PROTOCOL: 'https:ssh:file' },
    });
    await expect(machine(() => ({ exitCode: 1 })).folders.gitClone('https://h/r', '/w/r')).rejects.toThrow(
      'git clone failed',
    );
    await expect(machine(() => 'throw').folders.gitInit('/w/n')).rejects.toThrow('git init failed');
  });

  test('a new folder is made owner-only without creating parents, and a refusal is one plain sentence', async () => {
    const ok = machine(() => ({}));
    await ok.folders.makeDirectory('/work/new');
    expect(ok.calls[0]).toMatchObject({ program: 'mkdir', args: ['-m', '700', '--', '/work/new'] });
    await expect(machine(() => ({ exitCode: 1 })).folders.makeDirectory('/work/new')).rejects.toThrow(
      'project folder could not be created',
    );
  });
});
