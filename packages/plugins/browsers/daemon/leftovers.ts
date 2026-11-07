/**
 * Closing the browsers a ferret left under its own pane (today's `closeLeftoverBrowsers`, `fyd.ts`): the Warden's
 * remedy for a Chrome an agent launched and never closed, run only when the owner lets the Warden close leftovers
 * alone (`mayActAlone.closeLeftovers`, checked by the sweep before it calls this).
 *
 * THE PANE'S TREE IS READ AGAIN HERE, at the moment of closing, through Terminals (the one reader of a ferret's pane,
 * by the attach proof), and only the top-level browsers it finds under THAT pane are signalled: a sweep's older look
 * can never close anything else, and the ferret itself is never touched. The signal is sent through `kernel.spawn`
 * (`kill`, declared in `permissions.spawn`), never by a global.
 */
import type { FerretId, SpawnPort } from '@ferretry/kernel/contract';
import type { TerminalsApi } from '@ferretry/plugin-terminals/contract';

export interface LeftoverBrowserPorts {
  /** Terminals, while it is on: without it no pane can be read, so nothing is closed. */
  terminals(): TerminalsApi | undefined;
  /** SIGTERM one pid: `sent`, or `gone` when it had already exited. Throws on any other refusal. */
  terminate(pid: number): Promise<'sent' | 'gone'>;
}

/** How many leftover browsers were closed under the ferret's pane (see {@link LeftoverBrowserPorts}). */
export async function closeLeftoverBrowsers(ferret: FerretId, ports: LeftoverBrowserPorts): Promise<number> {
  const terminals = ports.terminals();
  if (terminals === undefined) return 0;
  const read = await terminals.paneBrowsers(ferret);
  if (read.kind === 'unobservable') throw new Error(read.reason);
  // A command started since the sweep looked (a new turn) may be using that browser: leave it.
  if (read.toolCommandRunning) return 0;
  let closed = 0;
  for (const browser of read.browsers) {
    // Never pid 1 or below, nor anything that is not a pid: `kill` reads those as process groups or every process.
    if (!Number.isSafeInteger(browser.pid) || browser.pid <= 1) continue;
    // Gone between the look and the signal is already closed, and is not counted.
    if ((await ports.terminate(browser.pid)) === 'sent') closed += 1;
  }
  return closed;
}

/** SIGTERM through `kernel.spawn`'s declared `kill`: exit 0 sent, "No such process" gone, anything else refused. */
export function spawnTerminate(spawn: Pick<SpawnPort, 'run'>): (pid: number) => Promise<'sent' | 'gone'> {
  return async pid => {
    const result = await spawn.run('kill', ['-TERM', String(pid)]);
    if (result.exitCode === 0) return 'sent';
    if (/no such process/iu.test(result.stderr)) return 'gone';
    const why = result.stderr.trim() || `kill exited ${result.exitCode}`;
    throw new Error(`the browser (pid ${pid}) could not be closed: ${why}`);
  };
}
