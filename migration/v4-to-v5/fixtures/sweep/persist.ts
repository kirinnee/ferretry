/**
 * Reboot survival for ONE sweep slot (slot.ts `persist` / `unpersist`): the pure parts. Nothing here touches the disk or
 * systemd, so the unit text, the escaping and the folder rules are tested without either (tests/unit/sweep-persist.test.ts).
 *
 * A slot normally lives under /tmp/claude-1000/sweep/slot<N> (wiped at boot) and its daemons are transient user services. A
 * PERSISTED slot lives in a persistent folder (default ~/.local/share/fy-sweep/slot<N>); the old /tmp path stays as a symlink
 * to it (recreated by every unit's ExecStartPre, because /tmp is empty after a boot), so every absolute path the two homes
 * recorded about themselves still resolves and nothing inside a home is rewritten. What IS rewritten is what the kit owns:
 * the env files, the wrapper copies, the unit files, the wrappers (fy4s<N>/fy5s<N>) and the pointer file that says where the
 * slot went. The units name the PERSISTENT paths only, so they start before /tmp holds anything.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** First line of every unit this kit writes; `unpersist` removes only a unit that carries exactly its own marker. */
export const unitMarker = (slot: number, name: string): string => `# fy-sweep-slot: ${String(slot)} ${name}`;

/** Where the kit's own persistence records live (pointer files). A folder of its own, never inside a slot or a home. */
export const persistStateDir = (home: string = homedir()): string => join(home, '.local', 'share', 'fy-sweep');

export const defaultPersistDir = (slot: number, home: string = homedir()): string =>
  join(persistStateDir(home), `slot${String(slot)}`);

export const pointerFile = (slot: number, home: string = homedir()): string =>
  join(persistStateDir(home), 'pointers', `slot${String(slot)}.json`);

/** The folder the user manager reads unit files from. */
export const userUnitDir = (home: string = homedir()): string => join(home, '.config', 'systemd', 'user');

// ─── systemd escaping ───────────────────────────────────────────────────────────────────────────────────────────────

/** `%` starts a specifier in almost every unit setting (Description, WorkingDirectory, StandardOutput, Exec lines): `%%` is a literal one. */
export const escapeSpecifiers = (value: string): string => value.split('%').join('%%');

/** In an Exec line `$` starts a variable expansion: `$$` is a literal one. */
const escapeDollars = (value: string): string => value.split('$').join('$$');

function assertPlain(value: string): void {
  if (/[\0\n\r]/u.test(value)) throw new Error('refusing: a unit setting may not hold a line break or NUL');
}

/** A value of a non-Exec setting (a path, a description). `%` doubled; line breaks refused. */
export function setting(value: string): string {
  assertPlain(value);
  return escapeSpecifiers(value);
}

// `%` and `$` count as plain here: they are doubled below, which is how a literal one is written.
const SAFE_WORD = /^[A-Za-z0-9_@+=:,./%$-]+$/u;

/**
 * One word of an ExecStart / ExecStartPre / ExecStop line. In those lines `$` starts a variable expansion and `%` a
 * specifier, so BOTH are doubled; a word with anything beyond [A-Za-z0-9_@+=:,./-] (and those two) is double-quoted with `\`
 * and `"` escaped; a lone `;` would end the command, so it is spelled `\;`. A line break or NUL is refused.
 */
export function execWord(word: string): string {
  assertPlain(word);
  if (word === ';') return '\\;';
  if (SAFE_WORD.test(word)) return escapeDollars(escapeSpecifiers(word));
  const quoted = escapeDollars(escapeSpecifiers(word.split('\\').join('\\\\').split('"').join('\\"')));
  return `"${quoted}"`;
}

/** A whole command line: the program (an absolute path) and its words. */
export function execLine(argv: readonly string[]): string {
  const [program] = argv;
  if (program === undefined || !isAbsolute(program) || /^[@\-:+!]/u.test(program))
    throw new Error(`refusing: ${String(program)} is not an absolute program path`);
  return argv.map(execWord).join(' ');
}

// ─── the units ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DaemonUnitSpec {
  readonly slot: number;
  /** `v4` / `v5`, and the human label used in descriptions. */
  readonly side: 'v4' | 'v5';
  readonly name: string;
  readonly terminalsName: string;
  readonly execStartPre: readonly string[];
  readonly execStart: readonly string[];
  readonly workingDirectory: string;
  readonly logFile: string;
}

const sideLabel = (side: 'v4' | 'v5'): string => (side === 'v4' ? 'v4' : '5.0');

/**
 * `fy<4|5>-slot<N>.service`: the same shape as the transient unit slot.ts starts (Restart=on-failure after 2 s, KillMode=process
 * so a daemon restart never kills a tmux server or a ferret, the log appended, the working directory), plus what a boot needs:
 * the symlink recreated first, the terminals service wanted and ordered before it, and an [Install] section so it is enabled.
 */
export function daemonUnitText(spec: DaemonUnitSpec): string {
  return [
    unitMarker(spec.slot, spec.name),
    '# Written by migration/v4-to-v5/fixtures/sweep/slot.ts (persist); remove with slot.ts unpersist, never by hand.',
    '[Unit]',
    `Description=${setting(`sweep slot ${String(spec.slot)} ${sideLabel(spec.side)} daemon`)}`,
    `Wants=${spec.terminalsName}`,
    `After=${spec.terminalsName}`,
    '',
    '[Service]',
    'Restart=on-failure',
    'RestartSec=2s',
    'KillMode=process',
    'TimeoutStopSec=30s',
    `WorkingDirectory=${setting(spec.workingDirectory)}`,
    `StandardOutput=append:${setting(spec.logFile)}`,
    `StandardError=append:${setting(spec.logFile)}`,
    `ExecStartPre=${execLine(spec.execStartPre)}`,
    `ExecStart=${execLine(spec.execStart)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export interface TerminalsUnitSpec {
  readonly slot: number;
  readonly side: 'v4' | 'v5';
  readonly name: string;
  readonly execStartPre: readonly string[];
  readonly execStart: readonly string[];
  readonly execStop: readonly string[];
}

/**
 * `fy<4|5>-slot<N>-terminals.service`: the tmux server on the side's own socket. `Type=oneshot` + `RemainAfterExit` because
 * `tmux start-server` forks its server and exits; `KillMode=process` so the server (not the unit's main process, which is gone)
 * is never killed by a stop of anything but this unit's own ExecStop (kill-server on the SAME socket). A daemon restart never
 * reaches it: it is a different unit.
 */
export function terminalsUnitText(spec: TerminalsUnitSpec): string {
  return [
    unitMarker(spec.slot, spec.name),
    '# Written by migration/v4-to-v5/fixtures/sweep/slot.ts (persist); remove with slot.ts unpersist, never by hand.',
    '[Unit]',
    `Description=${setting(`sweep slot ${String(spec.slot)} ${sideLabel(spec.side)} terminals (tmux server and panes)`)}`,
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    'KillMode=process',
    'TimeoutStopSec=30s',
    `ExecStartPre=${execLine(spec.execStartPre)}`,
    `ExecStart=${execLine(spec.execStart)}`,
    // `-`: a tmux server that is already gone is not a failed stop.
    `ExecStop=-${execLine(spec.execStop)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * Run by every unit's ExecStartPre: `/bin/sh link-slot.sh <persistent dir> <logical path>`. Makes the logical path (under /tmp,
 * empty after a boot) a symlink to the persistent folder. Absent -> created (with its parent, 0700); already the right link ->
 * left; anything else (a real folder, another link) -> exit 78, so a unit never starts on top of something it did not make.
 * Two units racing to make the same link both succeed (the loser finds the right link already there).
 */
export const LINK_SCRIPT = `#!/bin/sh
# Recreates the symlink that lets a persisted sweep slot be found at its logical (/tmp) path. See persist.ts.
set -eu
[ "$#" -eq 2 ] || { printf 'link-slot: usage: link-slot.sh <persistent dir> <logical path>\\n' >&2; exit 78; }
target=$1
link=$2
[ -d "$target" ] && [ ! -L "$target" ] || { printf 'link-slot: refusing: the persistent folder is missing or a link\\n' >&2; exit 78; }
if [ -L "$link" ]; then
  [ "$(readlink -- "$link")" = "$target" ] && exit 0
  printf 'link-slot: refusing: %s is a link to somewhere else\\n' "$link" >&2
  exit 78
fi
if [ -e "$link" ]; then
  printf 'link-slot: refusing: %s exists and is not a link\\n' "$link" >&2
  exit 78
fi
parent=$(dirname -- "$link")
mkdir -p -m 700 -- "$parent" || exit 78
# -n: a link that already leads to a folder is the destination itself, never a folder to put a second link INTO.
if ! ln -s -n -- "$target" "$link" 2>/dev/null; then
  # The v4 and 5.0 units both run this at boot with no ordering: the other one may have made the link a moment ago.
  # That is fine when it is the right link; anything else is refused.
  if [ -L "$link" ] && [ "$(readlink -- "$link")" = "$target" ]; then exit 0; fi
  printf 'link-slot: refusing: could not make %s a link to %s\\n' "$link" "$target" >&2
  exit 78
fi
`;

// ─── where a slot may be persisted ──────────────────────────────────────────────────────────────────────────────────

/**
 * The folders and files that belong to somebody else: never a place to put a slot, never to be inside one. A name here is a
 * PREFIX of the first folder under the home (`.claude` also covers `.claude-work`, `.codex` also `.codex-2`, `.ferretry` also
 * `.ferretry-v5`); `.secrets` is matched exactly.
 */
const FORBIDDEN_PREFIXES = ['.ferretry', '.claude', '.codex'] as const;
const FORBIDDEN_EXACT = ['.secrets'] as const;

/** Why `target` cannot be a persistent slot folder, or `undefined` when it can. Pure: it never looks at the disk. */
export function persistTargetProblem(opts: {
  readonly target: string;
  readonly sweepRoot: string;
  readonly home?: string;
}): string | undefined {
  const home = opts.home ?? homedir();
  const { target } = opts;
  if (!isAbsolute(target)) return `${target} is not an absolute path`;
  if (resolve(target) !== target) return `${target} is not a normalized path (no "..", no "//", no trailing "/")`;
  const inside = (parent: string): boolean => {
    const rel = relative(parent, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  if (inside(opts.sweepRoot)) return `${target} is inside the sweep root ${opts.sweepRoot}, which is wiped at boot`;
  if (inside('/tmp') || inside('/var/tmp') || inside('/dev/shm') || inside('/run'))
    return `${target} is a temporary folder (/tmp, /var/tmp, /dev/shm and /run do not survive a reboot reliably)`;
  const underHome = relative(home, target);
  const first = underHome.split('/')[0] ?? '';
  if (!underHome.startsWith('..') && !isAbsolute(underHome) && first !== '') {
    if (FORBIDDEN_PREFIXES.some(prefix => first.startsWith(prefix)) || FORBIDDEN_EXACT.some(name => first === name))
      return `${target} is inside ${join(home, first)}, which is not a sweep folder`;
  }
  if (inside(userUnitDir(home))) return `${target} is inside ${userUnitDir(home)}, where the unit files go`;
  if (target === home || target === '/') return `${target} is not a folder to give to one slot`;
  return undefined;
}

/**
 * What the pointer file (`pointerFile(slot)`) says about where a slot lives, checked as strictly as a fresh `persist` target:
 * `unpersist` MOVES the folder it names and `down` may delete it, so a pointer that names $HOME, ~/.ferretry or a folder under
 * /tmp must never be believed. `undefined` dir with no problem = no usable pointer (the slot is not persisted).
 */
export function pointerDir(opts: {
  readonly document: unknown;
  readonly slot: number;
  readonly sweepRoot: string;
  readonly home?: string;
}): { readonly dir?: string; readonly problem?: string } {
  const { document } = opts;
  if (typeof document !== 'object' || document === null) return {};
  const record = document as Record<string, unknown>;
  if (record.slot !== opts.slot || typeof record.dir !== 'string') return {};
  const problem = persistTargetProblem({ target: record.dir, sweepRoot: opts.sweepRoot, home: opts.home });
  return problem === undefined ? { dir: record.dir } : { problem };
}

// ─── restarting a persisted slot's tmux server ──────────────────────────────────────────────────────────────────────

export interface CommandResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface TerminalsPorts {
  /** The pid of the tmux server answering on the side's socket, or undefined when none does. */
  readonly serverPid: () => Promise<number | undefined>;
  /** `systemctl --user <args>`. */
  readonly systemctl: (args: readonly string[]) => Promise<CommandResult>;
}

/**
 * Brings a persisted side's tmux server back, called only when NO server answers on the socket. The terminals unit is a
 * oneshot with RemainAfterExit: after its tmux server died it still says active (exited), and `systemctl start` of an active
 * unit does nothing, so the server would never come back. `restart` runs ExecStop and ExecStart again whatever the state.
 */
export async function restartTerminals(
  ports: TerminalsPorts,
  unit: string,
): Promise<{ readonly pid: number } | { readonly why: string }> {
  const began = await ports.systemctl(['restart', unit]);
  const pid = await ports.serverPid();
  if (began.code === 0 && pid !== undefined) return { pid };
  return { why: `exit ${String(began.code)}: ${(began.err + began.out).trim().slice(0, 300)}` };
}

// ─── a persist that failed half way ─────────────────────────────────────────────────────────────────────────────────

export interface RevertPorts {
  /** Folder back where it was, link and pointer gone, persistence-only files removed. */
  readonly revert: () => Promise<void>;
  /** Both daemons started again as transient units, as `up` starts them: nothing removed, nothing re-created. */
  readonly restart: () => Promise<void>;
  readonly say: (line: string) => void;
}

/** What to tell the owner after a failed persist: the one thing NOT to do next. */
export const AFTER_FAILED_PERSIST =
  'do NOT run up / sweep-up.sh on this slot: it wipes the slot folder. Use status, and down only if you mean to stop it.';

/**
 * A persist stops both daemons before it moves anything. When it fails, the folder is put back AND the daemons are started
 * again, so a failure never leaves the slot stopped. The warning is said BEFORE the restart (a restart that dies must not
 * hide it). A revert that fails starts nothing: the folder's state is unknown, and starting daemons on it would be a guess.
 */
export async function revertFailedPersist(ports: RevertPorts, slot: number): Promise<'restarted' | 'not-reverted'> {
  ports.say(`slot ${String(slot)}: persist failed; putting the folder back and starting both daemons again`);
  ports.say(`  ${AFTER_FAILED_PERSIST}`);
  try {
    await ports.revert();
  } catch (error) {
    ports.say(
      `  could not put the folder back (${error instanceof Error ? error.message : String(error)}); nothing was started`,
    );
    return 'not-reverted';
  }
  await ports.restart();
  return 'restarted';
}

// ─── keeping the baked store paths alive ────────────────────────────────────────────────────────────────────────────

/** Every nix store path (the `/nix/store/<hash>-<name>` folder or file itself, never what is under it) that `text` mentions. */
export function storePathsIn(text: string): string[] {
  const found = text.match(/\/nix\/store\/[0-9a-z]{32}-[A-Za-z0-9+._?=-]+/gu) ?? [];
  return [...new Set(found)].sort();
}

/** The store path a file lives in (`/nix/store/<hash>-x/bin/y` -> `/nix/store/<hash>-x`), or undefined outside the store. */
export function storeRootOf(path: string): string | undefined {
  return storePathsIn(path)[0];
}

export interface RootPorts {
  /** `nix-store <args>`, or undefined when nix-store is not installed. */
  readonly nixStore: ((args: readonly string[]) => Promise<CommandResult>) | undefined;
}

/**
 * Adds a GC root under `dir` for every store path, named after the path (`<dir>/<hash>-<name>`), so a `nix-collect-garbage`
 * cannot delete a program a unit file or env file names. A root keeps the path's whole closure. `--indirect` is what lets
 * the root live outside /nix/var/nix/gcroots. Returns what is rooted and what could not be, with the reason.
 */
export async function addStoreRoots(
  ports: RootPorts,
  dir: string,
  paths: readonly string[],
): Promise<{ readonly rooted: string[]; readonly failed: { path: string; why: string }[] }> {
  const rooted: string[] = [];
  const failed: { path: string; why: string }[] = [];
  for (const path of [...new Set(paths)].sort()) {
    if (ports.nixStore === undefined) {
      failed.push({ path, why: 'nix-store is not on PATH' });
      continue;
    }
    const name = path.slice('/nix/store/'.length);
    const ran = await ports.nixStore(['--add-root', join(dir, name), '--indirect', '--realise', path]);
    if (ran.code === 0) rooted.push(path);
    else failed.push({ path, why: (ran.err + ran.out).trim().slice(0, 200) });
  }
  return { rooted, failed };
}
