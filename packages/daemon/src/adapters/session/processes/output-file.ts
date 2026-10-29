import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ConfiguredServersPort } from '../../../lib/migrate/configured-servers.ts';
import { identifyKnownProcesses } from '../../../lib/migrate/harness-provenance.ts';
import { readWindow } from '../../../lib/session/processes/output.ts';
import type {
  OutputFilePort,
  OutputFileRead,
  ProcessDetailRow,
  ProcessProvenancePort,
  ProcessSignalPort,
} from '../../../lib/session/processes/ports.ts';

/**
 * Reads a byte range of a regular file, and nothing else.
 *
 * THREE CHECKS, because a path is only a name. `lstat` must find a regular file (not a symlink, FIFO,
 * terminal or socket); the open is non-blocking and refuses to follow a symlink, so a FIFO swapped in
 * between the two can neither block this daemon nor be drained by it; and `fstat` on the opened
 * descriptor must be a regular file with the same device and inode `lstat` saw. Anything else is a
 * refusal, never a read.
 */
export class RegularOutputFile implements OutputFilePort {
  async read(path: string, from: number | undefined, max: number): Promise<OutputFileRead> {
    if (!isAbsolute(path)) return { kind: 'refused', reason: 'Its output path is not absolute.' };
    const named = await lstat(path).catch(() => undefined);
    if (named === undefined) return { kind: 'gone' };
    if (!named.isFile()) return { kind: 'refused', reason: 'Its output is not a regular file.' };
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch(
      () => undefined,
    );
    if (handle === undefined) return { kind: 'gone' };
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== named.ino || opened.dev !== named.dev)
        return { kind: 'refused', reason: 'Its output file changed while it was being opened.' };
      const window = readWindow(opened.size, from, max);
      const length = window.to - window.from;
      const bytes = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(bytes, filled, length - filled, window.from + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return { kind: 'read', bytes: bytes.subarray(0, filled), start: window.from, size: opened.size };
    } finally {
      await handle.close();
    }
  }
}

/** SIGTERM, with "already gone" answered rather than thrown. */
export class SigtermProcessSignal implements ProcessSignalPort {
  async terminate(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  }
}

/**
 * Which rows are the harness's own, by the same provenance the Warden and a migration use: the harness
 * process, Ferretry's tools server, a language server, and the MCP servers the project's `.mcp.json`
 * names (read from the directory the pane runs in, where that is readable).
 */
export class HarnessProcessProvenance implements ProcessProvenancePort {
  constructor(
    private readonly binaryName: string,
    private readonly servers: ConfiguredServersPort,
    private readonly procRoot: string | undefined = process.platform === 'linux' ? '/proc' : undefined,
  ) {}

  async identify(rows: readonly ProcessDetailRow[], rootPid: number) {
    const proc = this.procRoot;
    // Where there is no procfs the pane's directory is unknown, so its configured servers stay
    // unexplained — listed as helpers by the tree rule, never assumed to be anything else.
    const directory = proc === undefined ? undefined : await readlink(join(proc, String(rootPid), 'cwd')).catch(() => undefined);
    const configuredServers = directory === undefined ? [] : await this.servers.read(directory);
    return identifyKnownProcesses(
      rows.map(row => ({ pid: row.pid, ppid: row.ppid, startedSecondsAgo: 0, argv: row.argv })),
      { rootPid, binaryName: this.binaryName, configuredServers },
    );
  }
}
