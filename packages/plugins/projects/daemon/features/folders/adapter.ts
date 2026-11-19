import type { KernelPorts } from '@ferretry/kernel/contract';
import type { FolderBrowser, FolderReach } from './port.ts';

/**
 * The explorer's machine reads, through the kernel's read-only `imports` root only: it refuses Ferretry's own home,
 * resolves links and refuses device files. Names, kinds and times come back; no file is ever opened.
 */
export function kernelBrowser(kernel: Pick<KernelPorts, 'roots' | 'paths'>): FolderBrowser {
  const handle = (folder: string) => kernel.roots.root('imports', { subfolder: folder });
  const reach = async (path: string): Promise<FolderReach> => {
    const root = handle(path);
    const fenced = root.resolve('');
    if (!fenced.ok) return { ok: false, reason: 'refused' };
    try {
      const stat = await root.stat(fenced.value);
      if (stat === undefined) return { ok: false, reason: 'missing' };
      if (stat.kind !== 'directory') return { ok: false, reason: 'not_folder' };
      return { ok: true, path: await root.realPath(fenced.value) };
    } catch {
      return { ok: false, reason: 'refused' };
    }
  };
  return {
    home: async () => {
      const home = kernel.paths.home();
      const reached = await reach(home);
      return reached.ok ? reached.path : home;
    },
    reach,
    entries: async folder => {
      const root = handle(folder);
      const fenced = root.resolve('');
      if (!fenced.ok) return undefined;
      try {
        return (await root.entries(fenced.value)).map(({ name, kind, modified }) => ({ name, kind, modified }));
      } catch {
        return undefined;
      }
    },
    exists: async (folder, name) => {
      const root = handle(folder);
      const fenced = root.resolve(name);
      if (!fenced.ok) return true;
      try {
        return (await root.lstat(fenced.value)) !== undefined;
      } catch {
        // A name the root refuses is not one to make over either.
        return true;
      }
    },
    hasGit: async (folder, name) => {
      const root = handle(folder);
      const fenced = root.resolve(`${name}/.git`);
      if (!fenced.ok) return false;
      try {
        return (await root.lstat(fenced.value)) !== undefined;
      } catch {
        return false;
      }
    },
  };
}
