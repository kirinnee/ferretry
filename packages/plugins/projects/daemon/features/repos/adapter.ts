import type { KernelPorts } from '@ferretry/kernel/contract';
import { CONFIG_READ_LIMIT } from './scan.ts';

/**
 * Reads `<repo>/.git/config` through the kernel's `imports` root: no link on the way is followed, only a regular file is
 * read, and at most {@link CONFIG_READ_LIMIT} bytes. A work tree's `.git` is a file, not a folder, so it has no config
 * here and the repository simply shows no remote.
 */
export const kernelConfigReader =
  (kernel: Pick<KernelPorts, 'roots'>) =>
  async (repo: string): Promise<string | undefined> => {
    const handle = kernel.roots.root('imports', { subfolder: repo });
    const fenced = handle.resolve('.git/config');
    if (!fenced.ok) return undefined;
    try {
      return await handle.readText(fenced.value, CONFIG_READ_LIMIT);
    } catch {
      return undefined;
    }
  };
