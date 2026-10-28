/**
 * Which processes under a ferret's pane are WORK — a tool command the agent is waiting on — and which
 * are not: the harness itself, the helpers it keeps alive for the whole session, a server the agent
 * deliberately left running, and a browser left behind.
 *
 * WHY THIS EXISTS. The liveness layer used to read "the pane has any child process" as "a subprocess is
 * running". Every ferret's pane has `fy mcp serve` under it for as long as the session lives, so every
 * ferret looked busy forever and `sus_subprocess` fired on finished, idle ferrets several times a day.
 *
 * DECIDED BY THE TREE, NOT BY A NAME LIST. Both harnesses run a tool command through a shell they spawn
 * (`zsh -c …` for Claude, `bash -c …` for Codex), so:
 *
 * - a SHELL started by the harness (or by the pane itself) is a tool command, and so is everything
 *   below it;
 * - any other entry the harness started is a HELPER — an MCP server, a language server, Codex's app
 *   server — and so is everything below it (a Chrome an MCP server drives is the server's, not work);
 * - what {@link identifyKnownProcesses} already recognised keeps its kind.
 *
 * Inside a tool command two shapes are not work either: a entry holding a LISTENING socket is a
 * server the agent meant to keep up (a dev or board server), and a Chrome is a browser. A command whose
 * subtree holds one of those is the wrapper that started it. Both are judged by evidence, not by name,
 * except "is this Chrome", which has no other observable.
 *
 * Only processes whose ancestry runs through THIS pane are ever passed in (the walk starts at the pane
 * pid), so a entry belonging to another session, or the daemon's own tmux client, cannot be counted.
 *
 * Pure: no IO, no clock, no globals.
 */

/** One entry under the pane, as the inventory observed it. Parents are listed before children. */
export interface PaneProcess {
  readonly pid: number;
  /** Its parent; a parent not in the list is the pane itself. */
  readonly ppid?: number;
  readonly argv: string;
  readonly startedSecondsAgo?: number;
  /** Set when provenance recognised it as the agent's own (the tools server, the harness, …). */
  readonly known?: { readonly kind: string };
  /** It holds a listening socket: a server. `undefined` where that could not be observed. */
  readonly listening?: boolean;
}

export type PaneProcessRole = 'harness' | 'helper' | 'command' | 'service' | 'browser';

export interface PaneProcessView {
  /** Top-level tool commands still doing work, oldest first. */
  readonly toolCommands: readonly PaneProcess[];
  /** Top-level browsers the agent launched (not a helper's), which nothing needs once the turn is over. */
  readonly leftoverBrowsers: readonly PaneProcess[];
  /** Top-level servers the agent left running on purpose. */
  readonly services: readonly PaneProcess[];
  /** Every process's role, by pid. */
  readonly roles: ReadonlyMap<number, PaneProcessRole>;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'pwsh']);
const BROWSERS =
  /^(?:chrome|chromium|chromium-browser|google-chrome(?:-stable|-beta|-unstable)?|headless_shell|chrome-headless-shell|msedge|Google Chrome(?: for Testing)?|Chromium)$/u;

const head = (argv: string): string => argv.trim().split(/\s+/u)[0] ?? '';
const basename = (path: string): string => path.split('/').at(-1) ?? '';

/** The program's own name: a login shell's leading `-` dropped. */
function programName(argv: string): string {
  return basename(head(argv)).replace(/^-/u, '');
}

export function isShellProcess(argv: string): boolean {
  return SHELLS.has(programName(argv));
}

/** A Chrome-family browser, by the executable it runs (a `.app` bundle's binary included). */
export function isBrowserProcess(argv: string): boolean {
  const program = programName(argv);
  if (BROWSERS.test(program)) return true;
  return /\/(?:Google Chrome|Chromium)(?: for Testing)?\.app\//u.test(argv);
}

/**
 * Every process's role, then the top-level members of each class: an entry whose parent has the same
 * role is part of its parent's unit, not a unit of its own.
 */
export function classifyPaneProcesses(processes: readonly PaneProcess[]): PaneProcessView {
  const byPid = new Map(processes.map(entry => [entry.pid, entry]));
  const roles = new Map<number, PaneProcessRole>();
  for (const entry of processes) roles.set(entry.pid, roleOf(entry, byPid, roles));

  // A command that started a server or a browser is that server's or browser's wrapper: once the shell
  // has nothing else running, it is waiting on them, not working.
  const wrappers = new Set<number>();
  for (const entry of processes) {
    const role = roles.get(entry.pid);
    if (role !== 'service' && role !== 'browser') continue;
    for (let parent = entry.ppid; parent !== undefined && roles.get(parent) === 'command'; ) {
      wrappers.add(parent);
      parent = byPid.get(parent)?.ppid;
    }
  }
  const working = new Set<number>();
  for (const entry of processes)
    if (roles.get(entry.pid) === 'command' && !wrappers.has(entry.pid)) working.add(entry.pid);

  const topLevel = (role: PaneProcessRole): readonly PaneProcess[] =>
    processes.filter(
      entry => roles.get(entry.pid) === role && (entry.ppid === undefined || roles.get(entry.ppid) !== role),
    );
  // A tool command is working when it, or a command below it, is not merely a wrapper.
  const toolCommands = topLevel('command')
    .filter(entry => subtreeOf(entry.pid, processes).some(pid => working.has(pid)))
    .toSorted((left, right) => (right.startedSecondsAgo ?? 0) - (left.startedSecondsAgo ?? 0));
  return {
    toolCommands,
    leftoverBrowsers: topLevel('browser'),
    services: topLevel('service'),
    roles,
  };
}

function roleOf(
  entry: PaneProcess,
  byPid: ReadonlyMap<number, PaneProcess>,
  roles: ReadonlyMap<number, PaneProcessRole>,
): PaneProcessRole {
  if (entry.known?.kind === 'harness') return 'harness';
  if (entry.known !== undefined) return 'helper';
  const parentRole = entry.ppid === undefined || !byPid.has(entry.ppid) ? undefined : roles.get(entry.ppid);
  // Below a helper, a browser or a server, everything belongs to it.
  if (parentRole === 'helper' || parentRole === 'browser' || parentRole === 'service') return parentRole;
  // Inside a tool command: a browser is a browser, a listening process a server, the rest more command.
  if (parentRole === 'command') {
    if (isBrowserProcess(entry.argv)) return 'browser';
    return entry.listening === true ? 'service' : 'command';
  }
  // Started by the pane or the harness itself: a shell is how a tool command runs, anything else — a
  // browser the harness drives included — is a helper the harness keeps for the session.
  return isShellProcess(entry.argv) ? 'command' : 'helper';
}

function subtreeOf(rootPid: number, processes: readonly PaneProcess[]): readonly number[] {
  const members = new Set([rootPid]);
  for (const entry of processes) if (entry.ppid !== undefined && members.has(entry.ppid)) members.add(entry.pid);
  return [...members];
}

/** What the liveness look keeps of a pane's processes: whether work runs, which, and a leftover browser. */
export interface PaneWorkSummary {
  /** A tool command is running under the pane. */
  readonly toolCommand: boolean;
  /** Identity of the youngest running tool command — a different one starts a new episode. */
  readonly commandKey?: string;
  /** A browser the agent launched is still running. */
  readonly leftoverBrowser: boolean;
}

export function paneWorkSummary(processes: readonly PaneProcess[]): PaneWorkSummary {
  const view = classifyPaneProcesses(processes);
  // The YOUNGEST command is the one being waited on: a watcher started early (`tsc -w`) must not stand
  // for every command after it.
  const youngest = view.toolCommands.at(-1);
  return {
    toolCommand: youngest !== undefined,
    ...(youngest === undefined ? {} : { commandKey: `pid:${youngest.pid}` }),
    leftoverBrowser: view.leftoverBrowsers.length > 0,
  };
}
