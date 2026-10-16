/**
 * Reading who listens on Codex's callback ports, and stopping one program.
 *
 * `lsof` first: macOS ships it, and it names the listener's owner as well as its pid. A Linux host
 * without it falls back to `ss`, which names a pid only for this user's own listeners — the only ones
 * this daemon could stop anyway. `ps` then gives each listener's owner and whole command line, which is
 * what `../../lib/fleet-login/port-holders.ts` decides on. A host with none of these answers
 * `undefined`, and starting over then clears nothing rather than guessing.
 *
 * Every tool is run as an argv ARRAY with no shell, and the paths are injectable so the integration
 * tier can exercise each branch on any host.
 */
import type { CallbackPortHolder } from '../../lib/fleet-login/port-holders.ts';
import { parseLsofListeners, parsePsLine, parseSsListeners } from '../../lib/fleet-login/port-holders.ts';
import type { HarnessLoginPortHolders } from '../../lib/fleet-login/ports.ts';

/** How long a stopped program is given to exit before it is killed outright. */
const STOP_GRACE_MS = 2_000;
const STOP_POLL_MS = 50;

interface PortHolderTools {
  readonly lsof?: string;
  readonly ss?: string;
  readonly ps?: string;
  /** How long a stopped program is given before `SIGKILL`. */
  readonly graceMs?: number;
}

/** Run one tool. `undefined` when it is not installed or could not be started. */
async function run(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string } | undefined> {
  try {
    const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, stdout };
  } catch {
    return undefined;
  }
}

/** Send one signal. False when there was nobody to send it to, or nobody this user may signal. */
const signal = (pid: number, name: 'SIGTERM' | 'SIGKILL' | 0): boolean => {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
};

export function systemPortHolders(tools: PortHolderTools = {}): HarnessLoginPortHolders {
  const lsof = tools.lsof ?? 'lsof';
  const ss = tools.ss ?? 'ss';
  const ps = tools.ps ?? 'ps';
  const graceMs = tools.graceMs ?? STOP_GRACE_MS;

  /** One port's listeners. `undefined` when neither table could be read. */
  const listeners = async (
    port: number,
  ): Promise<
    readonly { readonly pid: number | undefined; readonly name: string; readonly uid?: number }[] | undefined
  > => {
    // `lsof` exits 1 when nothing matched, which is an answer; only a missing tool falls through.
    const listed = await run([lsof, '-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fpcu']);
    if (listed !== undefined) {
      return parseLsofListeners(listed.stdout).map(entry => ({
        pid: entry.pid,
        name: entry.name,
        ...(entry.uid === undefined ? {} : { uid: entry.uid }),
      }));
    }
    const table = await run([ss, '-Hltnp', `sport = :${String(port)}`]);
    return table === undefined || table.code !== 0 ? undefined : parseSsListeners(table.stdout);
  };

  /** Fill in the owner and command line `ps` reports, keeping whatever the port table already said. */
  const described = async (
    port: number,
    entry: { readonly pid: number | undefined; readonly name: string; readonly uid?: number },
  ): Promise<CallbackPortHolder> => {
    const listed = entry.pid === undefined ? undefined : await run([ps, '-o', 'uid=,args=', '-p', String(entry.pid)]);
    const line = listed === undefined ? undefined : parsePsLine(listed.stdout);
    return {
      port,
      pid: entry.pid,
      name: entry.name,
      uid: line?.uid ?? entry.uid,
      commandLine: line?.commandLine,
    };
  };

  return {
    ownUid: process.getuid?.(),
    holders: async ports => {
      const holders: CallbackPortHolder[] = [];
      for (const port of ports) {
        const found = await listeners(port);
        if (found === undefined) return undefined;
        for (const entry of found) holders.push(await described(port, entry));
      }
      return holders;
    },
    stop: async pid => {
      if (!signal(pid, 'SIGTERM')) return false;
      for (let waited = 0; waited < graceMs; waited += STOP_POLL_MS) {
        if (!signal(pid, 0)) return true;
        await Bun.sleep(STOP_POLL_MS);
      }
      // Gone between the last look and this one is still gone, so whether this lands does not matter.
      signal(pid, 'SIGKILL');
      return true;
    },
  };
}
