/**
 * Closing the browsers a ferret left under its own pane (today's `closeLeftoverBrowsers`, `fyd.ts`): the Warden's
 * remedy for a Chrome an agent launched and never closed, run only when the owner lets the Warden close leftovers
 * alone (`mayActAlone.closeLeftovers`, checked by the sweep before it calls this).
 *
 * THE PANE'S TREE IS READ AGAIN HERE, at the moment of closing, through Terminals (the one reader of a ferret's pane,
 * by the attach proof), and only the top-level browsers it finds under THAT pane are candidates: a sweep's older look
 * can never close anything else, and the ferret itself is never touched.
 *
 * ONLY WHAT IT CAN PROVE IS SIGNALLED. Each browser is named by its pid AND its start (the attach proof's process
 * identity), and Terminals re-proves it by a fresh walk IMMEDIATELY before its `kill`: the same process, still a
 * top-level browser under that pane, no tool command running. Anything else — a re-proof that is false, throws, or
 * cannot be asked because Terminals went off; a pid of 1 or below; a refused signal — is LEFT ALONE and reported with
 * a closed reason, never free text or argv, and the rest are still tried. The signal is sent through `kernel.spawn`
 * (`kill`, declared in `permissions.spawn`), never by a global.
 */
import type { FerretId, SpawnPort } from '@ferretry/kernel/contract';
import type { LeftoverBrowsersClosed, LeftAloneWhy } from '../contract/index.ts';
import type { PaneBrowser, PaneBrowserStill, TerminalsApi } from '@ferretry/plugin-terminals/contract';

export interface LeftoverBrowserPorts {
  /** Terminals, while it is on: without it no pane can be read or re-proved, so nothing is closed. */
  terminals(): TerminalsApi | undefined;
  /** SIGTERM one pid: `sent`, or `not-sent` when `kill` did not deliver it (read from its exit code alone). */
  terminate(pid: number): Promise<'sent' | 'not-sent'>;
}

const NONE: LeftoverBrowsersClosed = { closed: 0, leftAlone: [] };

/** Terminals' fresh re-proof of one browser; one that throws, or cannot be asked, proves nothing. */
async function reprove(ports: LeftoverBrowserPorts, ferret: FerretId, browser: PaneBrowser): Promise<PaneBrowserStill> {
  const terminals = ports.terminals();
  if (terminals === undefined) return { still: false, why: 'not-proved' };
  try {
    return await terminals.paneBrowserStill(ferret, browser);
  } catch {
    return { still: false, why: 'not-proved' };
  }
}

/** Close the leftover browsers under the ferret's pane (see {@link LeftoverBrowserPorts}): what closed, what was not. */
export async function closeLeftoverBrowsers(
  ferret: FerretId,
  ports: LeftoverBrowserPorts,
): Promise<LeftoverBrowsersClosed> {
  const terminals = ports.terminals();
  if (terminals === undefined) return NONE;
  const read = await terminals.paneBrowsers(ferret);
  if (read.kind === 'unobservable') throw new Error(read.reason);
  let closed = 0;
  const leftAlone: { pid: number; why: LeftAloneWhy }[] = [];
  const leave = (pid: number, why: LeftAloneWhy): void => {
    leftAlone.push({ pid, why });
  };
  for (const browser of read.browsers) {
    // Never pid 1 or below, nor anything that is not a pid: `kill` reads those as process groups or every process.
    // One that is not a whole number at all is reported as -1.
    if (!Number.isSafeInteger(browser.pid) || browser.pid <= 1) {
      leave(Number.isSafeInteger(browser.pid) ? browser.pid : -1, 'invalid-pid');
      continue;
    }
    // A command started since the sweep looked (a new turn) may be using that browser: leave it.
    if (read.toolCommandRunning) {
      leave(browser.pid, 'tool-running');
      continue;
    }
    const still = await reprove(ports, ferret, browser);
    if (!still.still) {
      leave(browser.pid, still.why);
      continue;
    }
    // Proved a moment ago: a signal that does not land is refused, whatever `kill` says about why.
    if ((await ports.terminate(browser.pid).catch(() => 'not-sent' as const)) === 'sent') closed += 1;
    else leave(browser.pid, 'signal-refused');
  }
  return { closed, leftAlone };
}

/**
 * SIGTERM through `kernel.spawn`'s declared `kill`, in the C locale, judged by its exit code alone (0 is sent; any other
 * is not), so no message text in any language is ever read.
 */
export function spawnTerminate(spawn: Pick<SpawnPort, 'run'>): (pid: number) => Promise<'sent' | 'not-sent'> {
  return async pid => {
    const result = await spawn.run('kill', ['-TERM', String(pid)], { env: { LC_ALL: 'C' } });
    return result.exitCode === 0 ? 'sent' : 'not-sent';
  };
}
