import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import type { WorktreeClock, WorktreeFileSystem, WorktreeFileType } from '../../lib/worktrees/ports.ts';

export class NodeWorktreeFileSystem implements WorktreeFileSystem {
  async makeDirectory(target: string, mode: number): Promise<void> {
    await mkdir(target, { recursive: true, mode });
  }

  async realPath(target: string): Promise<string> {
    return await realpath(target);
  }

  async type(target: string): Promise<WorktreeFileType> {
    try {
      const stats = await lstat(target);
      if (stats.isDirectory()) return 'directory';
      if (stats.isFile()) return 'file';
      if (stats.isSymbolicLink()) return 'symlink';
      return 'other';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  async readText(target: string): Promise<string> {
    return await readFile(target, 'utf8');
  }

  async writeText(target: string, content: string, mode: number): Promise<void> {
    await writeFile(target, content, { encoding: 'utf8', mode, flag: 'wx' });
  }
}

export class SystemWorktreeClock implements WorktreeClock {
  nowIso(): string {
    return new Date().toISOString();
  }
}
