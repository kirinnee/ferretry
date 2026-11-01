import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { NodeGuardDisk } from '@ferretry/fleet/adapters';
import type { AgentFilesystem } from '../../lib/agent-files/index.ts';

/**
 * The agent file tools' disk, over Node: the state-home guard's disk (`NodeGuardDisk`), plus the daemon's own
 * folders and copies. Created files are never executable and never follow a link.
 */
export class NodeAgentFilesystem extends NodeGuardDisk implements AgentFilesystem {
  async mkdirp(path: string, mode: number): Promise<void> {
    await mkdir(path, { recursive: true, mode });
  }

  async writeNew(path: string, bytes: Uint8Array, mode: number): Promise<void> {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  }

  async remove(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    await rm(path, { force: true, recursive: options?.recursive === true });
  }
}
