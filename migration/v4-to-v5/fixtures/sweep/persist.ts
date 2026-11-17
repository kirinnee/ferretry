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
ln -s -- "$target" "$link" || exit 78
`;

// ─── where a slot may be persisted ──────────────────────────────────────────────────────────────────────────────────

/** The folders and files that belong to somebody else: never a place to put a slot, never to be inside one. */
const FORBIDDEN_HOMES = ['.ferretry', '.ferretry-v5', '.claude', '.codex', '.secrets'] as const;

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
  for (const name of FORBIDDEN_HOMES)
    if (inside(join(home, name))) return `${target} is inside ${join(home, name)}, which is not a sweep folder`;
  if (inside(userUnitDir(home))) return `${target} is inside ${userUnitDir(home)}, where the unit files go`;
  if (target === home || target === '/') return `${target} is not a folder to give to one slot`;
  return undefined;
}
