import { join } from 'node:path';
import { readdir, readFile, readlink } from '../../host/fs.ts';

/**
 * Which of a ferret's processes listen on a TCP port (today's `BunProcessProbe.listening`, the part the Processes tab
 * reads): the LISTEN inodes of `/proc/net/tcp{,6}`, matched against each pid's socket descriptors. `undefined`
 * where there is no procfs.
 */
export class ProcfsListeningProbe {
  constructor(private readonly procRoot: string | undefined) {}

  async listening(pids: readonly number[]): Promise<ReadonlySet<number> | undefined> {
    const proc = this.procRoot;
    if (proc === undefined) return undefined;
    const inodes = new Set<string>();
    for (const table of ['tcp', 'tcp6']) {
      const text = await readFile(join(proc, 'net', table), 'utf8').catch(() => '');
      for (const inode of listeningInodes(text)) inodes.add(inode);
    }
    const found = new Set<number>();
    if (inodes.size === 0) return found;
    for (const pid of pids) {
      const fds = await readdir(join(proc, String(pid), 'fd')).catch(() => []);
      for (const fd of fds) {
        const link = await readlink(join(proc, String(pid), 'fd', fd)).catch(() => '');
        const inode = /^socket:\[(\d+)\]$/u.exec(link)?.[1];
        if (inode !== undefined && inodes.has(inode)) {
          found.add(pid);
          break;
        }
      }
    }
    return found;
  }
}

/** The socket inodes a `/proc/net/tcp`-format table lists in state `0A` (LISTEN). */
function listeningInodes(table: string): readonly string[] {
  const inodes: string[] = [];
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields[3] === '0A' && fields[9] !== undefined && fields[9] !== '0') inodes.push(fields[9]);
  }
  return inodes;
}

const ELAPSED_SECONDS_PER_UNIT = [1, 60, 3600] as const;
const SECONDS_PER_DAY = 86_400;

/**
 * `ps -o etime=` as seconds: `[[dd-]hh:]mm:ss`, or a bare `ss`. It is the one elapsed-time keyword
 * both procps (Linux) and BSD `ps` (macOS) accept — `etimes` is procps-only.
 */
export function parseElapsed(text: string): number | undefined {
  const match = text.match(/^(?:(\d+)-)?(\d+(?::\d+){0,2})$/);
  if (!match) return undefined;
  const fields = match[2]!.split(':').map(Number).reverse();
  const clock = fields.reduce((sum, value, index) => sum + value * ELAPSED_SECONDS_PER_UNIT[index]!, 0);
  return Number(match[1] ?? 0) * SECONDS_PER_DAY + clock;
}
