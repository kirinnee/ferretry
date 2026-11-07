import { resolve } from 'node:path';
import type { KernelPorts } from '@ferretry/kernel/contract';
import type { ProjectFolders } from '../lib/ports.ts';

/**
 * The transports a clone may use, handed to git itself. `ProjectCloneUrlSchema` already refuses every other one; this
 * is the same set where git enforces it, so a host git configuration that enables `ext::`, or anything git follows on
 * the way, cannot reach a transport that runs a command.
 */
const CLONE_PROTOCOLS = 'https:ssh:file';

/**
 * The folder and git questions registering a project asks, through the kernel's roots and spawn ports only. The
 * owner names the folder, so it is read through the `imports` root (outside Ferretry's own home, links resolved,
 * device files refused) rather than by path.
 */
export function kernelFolders(kernel: Pick<KernelPorts, 'roots' | 'spawn'>): ProjectFolders {
  const git = async (args: readonly string[], env?: Readonly<Record<string, string>>) => {
    try {
      return await kernel.spawn.run('git', args, env === undefined ? undefined : { env });
    } catch {
      // A host without git makes the spawn itself fail, which is not a non-zero exit.
      return undefined;
    }
  };
  const gitOk = async (args: readonly string[], env?: Readonly<Record<string, string>>): Promise<void> => {
    const done = await git(args, env);
    if (done?.exitCode === 0) return;
    throw new Error(`git ${args[0] ?? 'operation'} failed`);
  };
  return {
    isDirectory: async path => {
      const handle = kernel.roots.root('imports', { subfolder: path });
      const fenced = handle.resolve('');
      if (!fenced.ok) return false;
      try {
        return (await handle.stat(fenced.value))?.kind === 'directory';
      } catch {
        return false;
      }
    },
    canonical: async path => {
      // Git resolves links; a folder that is not a work tree is taken as given (no resolver is declared for it).
      const done = await git(['-C', path, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--show-prefix']);
      if (done?.exitCode !== 0) return path;
      const [top, prefix = ''] = done.stdout.split('\n');
      if (top === undefined || !top.startsWith('/')) return path;
      return prefix.trim() === '' ? top : `${top.replace(/\/+$/, '')}/${prefix.trim().replace(/\/+$/, '')}`;
    },
    makeDirectory: async path => {
      try {
        const done = await kernel.spawn.run('mkdir', ['-m', '700', '--', path]);
        if (done.exitCode === 0) return;
      } catch {
        // falls through to the one sentence below
      }
      throw new Error('project folder could not be created');
    },
    gitInit: async path => await gitOk(['init', path]),
    gitClone: async (url, path) => await gitOk(['clone', '--', url, path], { GIT_ALLOW_PROTOCOL: CLONE_PROTOCOLS }),
    gitCommonDirectory: async root => {
      const absolute = await git(['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
      const out = absolute?.exitCode === 0 ? absolute.stdout.trim() : '';
      if (out.startsWith('/')) return out;
      const relative = await git(['-C', root, 'rev-parse', '--git-common-dir']);
      const plain = relative?.exitCode === 0 ? relative.stdout.trim() : '';
      return plain === '' ? undefined : resolve(root, plain);
    },
  };
}
