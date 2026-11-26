import { readFile } from 'node:fs/promises';
import type { OrphanChromeInspector, ProcessIdentity, SignalOutcome } from '../control/adapters/orphan-chrome.ts';

// GAP (kernel port): reading `/proc` and signalling a pid need the real process table and a real clock.

/** Field 22 of `/proc/<pid>/stat` (start time in ticks) and the state, after the parenthesised command name. */
function readStat(text: string): { readonly state: string; readonly ticks: string } | undefined {
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
  const state = rest[0];
  const ticks = rest[19];
  return state && ticks ? { state, ticks } : undefined;
}

/**
 * Identity from `/proc` (Linux). Where there is no `/proc` nothing can be identified, so nothing is ever signalled:
 * a flattened `ps` line loses argument boundaries and cannot prove which profile a process holds.
 */
export function systemOrphanChromeInspector(): OrphanChromeInspector {
  let bootId: Promise<string | undefined> | undefined;
  const boot = (): Promise<string | undefined> =>
    (bootId ??= readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(
      text => text.trim(),
      () => undefined,
    ));
  return {
    identify: async (pid): Promise<ProcessIdentity | undefined> => {
      try {
        const id = await boot();
        if (id === undefined) return undefined;
        const before = readStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
        if (before === undefined || before.state === 'Z' || before.state === 'X') return undefined;
        const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(part => part !== '');
        // The same process answered both reads, or neither is trusted.
        const after = readStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
        if (after?.ticks !== before.ticks) return undefined;
        return { startedAt: `${id}:${before.ticks}`, args };
      } catch {
        return undefined;
      }
    },
    signal: (pid, signal): SignalOutcome => {
      try {
        process.kill(pid, signal);
        return 'delivered';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'denied';
      }
    },
    sleep: milliseconds => Bun.sleep(milliseconds),
  };
}
