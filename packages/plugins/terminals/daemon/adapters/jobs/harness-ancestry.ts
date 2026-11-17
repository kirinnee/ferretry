import { isHarnessCommand } from '@ferretry/std';
import { procStatStartTicks } from '../../lib/protocol/process-incarnation.ts';
import { readText } from '../host/fs.ts';

/** How far up the process tree to look: a tool shell sits a few levels below its harness. */
const MAX_DEPTH = 32;

/** Field 4 of `/proc/<pid>/stat`: the parent pid. `(comm)` may hold spaces and parentheses, so it is read after the last `)`. */
function parentPid(stat: string): number | undefined {
  const close = stat.lastIndexOf(')');
  const ppid = Number(stat.slice(close + 2).split(' ')[1]);
  return Number.isSafeInteger(ppid) ? ppid : undefined;
}

/**
 * The nearest ancestor of `pid` that runs a harness CLI, with its start (the kernel's tick count) — Linux only, from
 * procfs. Anything unreadable ends the walk with `undefined`: an attachment with no known harness is never an orphan.
 */
export async function harnessAncestor(
  pid: number,
  procRoot = '/proc',
): Promise<{ readonly pid: number; readonly start: string } | undefined> {
  let current = pid;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    let stat: string;
    try {
      stat = await readText(`${procRoot}/${current}/stat`);
    } catch {
      return undefined;
    }
    const parent = parentPid(stat);
    if (parent === undefined || parent <= 1) return undefined;
    try {
      const command = (await readText(`${procRoot}/${parent}/cmdline`)).split('\0').join(' ').trim();
      if (isHarnessCommand(command)) {
        const start = procStatStartTicks(await readText(`${procRoot}/${parent}/stat`));
        return start === undefined ? undefined : { pid: parent, start: String(start) };
      }
    } catch {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}
