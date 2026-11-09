/**
 * The preview's two programs: `dryRun` says what a run would do and touches nothing; `prepare` makes the preview
 * home from a v4 home and proves v4 was left alone. Neither starts a daemon. Every path is a parameter so a test
 * runs both in temp folders.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { convert } from '../src/convert.ts';
import type { LockProbe } from '../src/preflight.ts';
import { type ConversionReport, summarise } from '../src/report.ts';
import { PREVIEW_WORKSPACE } from '../src/v5/harness-paths.ts';
import { previewShellEnv } from '../src/v5/preview-env.ts';
import { gateFiles, gateForecast, type Spellings } from './gate.ts';
import { ALLOWED, GAPS, LEFT_BEHIND, PREVIEW, SESSION_FILES, stepPlan } from './plan.ts';
import { guardTarget, hasMarker, PREVIEW_MARKER, PREVIEW_MARKER_TEXT } from './paths.ts';
import {
  compare,
  parseSnapshot,
  proofPathFor,
  removeProof,
  snapshot,
  VOLATILE,
  writeProof,
  type HostFacts,
  type Verdict,
} from './proof.ts';
import { stage, walk } from './stage.ts';

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** The staging folder is a private copy; it sits beside the preview home, never inside v4's. */
export const stagingFor = (target: string) => `${target}.staging`;

export async function dryRun(
  v4Home: string,
  target: string,
  home: string = homedir(),
  given: Spellings = {},
): Promise<string> {
  const walked = await walk(v4Home);
  const forecast = await gateForecast(v4Home, home, walked.files, given);
  const plan = stepPlan();
  const groups = new Map<string, { files: number; bytes: number }>();
  for (const file of walked.files) {
    const parts = file.path.split('/');
    const key =
      parts[0] === 'state' && parts[1] === 'sessions'
        ? 'state/sessions/<ferret>/<allowed files>'
        : parts.slice(0, 2).join('/');
    const row = groups.get(key) ?? { files: 0, bytes: 0 };
    groups.set(key, { files: row.files + 1, bytes: row.bytes + file.bytes });
  }
  const lines: string[] = [
    `DRY RUN: nothing is copied, converted, started or written. v4 home: ${v4Home}`,
    `preview home: ${target}   port ${PREVIEW.port}   wrapper ${join(target, 'bin', PREVIEW.wrapper)}`,
    '',
    `WOULD COPY ${walked.files.length} files (${mib(walked.files.reduce((sum, file) => sum + file.bytes, 0))}) into ${stagingFor(target)}:`,
    ...[...groups]
      .sort()
      .map(([key, row]) => `  ${String(row.files).padStart(6)} files  ${mib(row.bytes).padStart(10)}  ${key}`),
    '',
    `ferret files copied (each ferret folder): ${SESSION_FILES.join(', ')}`,
    `allowlist rows: ${ALLOWED.length}. SQLite files, if any, are copied through the engine (VACUUM INTO).`,
    '',
    'LEFT OUT BY PATH, BEFORE ANY COPY (a left folder is counted, never listed):',
    ...LEFT_BEHIND.map(row => `  ${row.path.padEnd(70)} ${row.why}`),
    `  walk found ${walked.left.length} top-level or per-ferret items left (credential and harness folders among them, unlisted).`,
    '',
    `CONVERTER STEPS THAT RUN (${plan.run.length}): ${plan.run.map(step => step.id).join(', ')}`,
    `CONVERTER STEPS SKIPPED (${plan.skipped.length}):`,
    ...plan.skipped.map(step => `  ${step.id.padEnd(16)} ${step.why}`),
    ...(plan.unknown.length > 0 ? [`  UNKNOWN skipped ids (a step was renamed): ${plan.unknown.join(', ')}`] : []),
    '',
    'IN THE PREVIEW HOME EVERY FERRET IS STOPPED: no launch command, no terminal handle, no transcript pointer, no',
    'credential hash, no token ledger, no worktree ownership. The runtimes config says autoResume: false.',
    'LOGINS ARE LEFT OUT ENTIRELY (config/logins is not copied): you add logins fresh in the preview.',
    'LAST GATE: only fields that are EXECUTED or RESOLVED AS PATHS are checked (a ferret command, agent, folder, env and flags; every',
    'command, argument, env value, home and path of a runtime, profile, component, preset or MCP server). Free text (messages, events,',
    'prompts, notes) is neither gated nor redacted. A hit refuses the whole home, naming file and field, never the value. Spellings',
    'checked: v4 home and its -worktrees folder (resolved, as given, ~/, $HOME, ${HOME}, URL-encoded) and <home>/.claude*, .codex*.',
    forecast.length === 0
      ? 'GATE FORECAST: no file of the copy would be hit (a lower bound: the converter rewrites some ferret fields).'
      : `GATE FORECAST: ${forecast.length} field(s) the gate would hit (the home would be refused):`,
    ...forecast.map(line => `  ${line}`),
    `FOLDERS: a ferret whose folder is inside v4's home or its worktree folder, inside a worktree v4's ledger lists, or under a .worktrees folder gets ${join(target, PREVIEW_WORKSPACE)} instead (it lost its folder). A ferret in a primary checkout keeps it, and shares that checkout with v4's agents.`,
    `RESOURCE LIMITS: limits.yaml is NOT read for launches in 5.0. The preview daemon starts with XDG_RUNTIME_DIR set to ${join(target, PREVIEW.xdgRunFolder)} (private) and no DBUS_SESSION_BUS_ADDRESS, so it reaches no user systemd manager: launches run directly, with no slice, scope or set-property, and \`preview.sh start\` refuses to start if it can reach your manager.`,
    "LOGIN SHELLS: preview Claude ferrets get __ETC_PROFILE_NIX_SOURCED=1, FY_HOME, FY_PORT and FY_URL in a harness settings item so bash -l and zsh -li find the preview's fy; `preview.sh start` refuses to start unless they do. In a preview terminal you open yourself, `fy` may be v4's: type `~/.ferretry-v5/bin/fy` or use `fy5`.",
    '',
    '',
    'KNOWN GAPS:',
    ...GAPS.map(gap => `  - ${gap}`),
    '',
    'THEN: fresh daemon identity and empty vault come from the 5.0 daemon at first start; nothing from v4 is reused.',
    `START (owner): ${join(target, 'bin', PREVIEW.wrapper)} daemon start   (FY_HOME, FY_PORT=${PREVIEW.port}, FY_URL pinned to it; no service unit)`,
    '',
    `PROOF v4 was untouched: config files hashed and credential paths stat'ed (never read) before and after. Volatile, not hashed:`,
    ...VOLATILE.map(row => `  ${row}`),
  ];
  return lines.join('\n');
}

export interface PrepareInputs {
  readonly v4Home: string;
  readonly target: string;
  readonly lock: LockProbe;
  readonly now: () => Date;
  /** The user's home directory, for the path guard and the last gate; defaults to the real one. */
  readonly home?: string;
  /** v4's home as the caller named it (before links were resolved), so the gate knows that spelling too. */
  readonly v4Given?: string;
  /** Where the host keeps `$XDG_RUNTIME_DIR` and the user id, for the lifecycle claim files the proof stats. */
  readonly runtimeDir?: string | undefined;
  readonly uid?: number | undefined;
}

export interface Prepared {
  readonly report: ConversionReport | undefined;
  readonly summary: string;
  readonly proof: Verdict;
  readonly changedWhileCopying: readonly string[];
  /** `<file>: <field>` lines (names only) the last gate found naming v4 or a harness home; the home was removed. */
  readonly gate: readonly string[];
}

/** Stage, convert, delete the staging copy, prove v4 unchanged. Refuses a target that exists and is not empty. */
export async function prepare(inputs: PrepareInputs): Promise<Prepared> {
  const home = inputs.home ?? homedir();
  const guarded = guardTarget(inputs.v4Home, inputs.target, home);
  const { v4Home, target } = guarded;
  const existing = await readdir(target).catch(() => undefined);
  if (existing !== undefined && existing.length > 0)
    throw new Error(`${target} is not empty; the preview is made once. Run clean first.`);

  const facts: HostFacts = {
    userHome: home,
    runtimeDir: inputs.runtimeDir ?? process.env.XDG_RUNTIME_DIR,
    uid: inputs.uid ?? process.getuid?.(),
  };
  const before = await snapshot(v4Home, facts);
  const staging = guarded.staging;
  await rm(staging, { recursive: true, force: true });
  const staged = await stage(v4Home, staging);

  // The converter reads the host only for the archive-setting step, which is skipped; this folder is empty on purpose.
  const emptyHost = await mkdtemp(join(tmpdir(), 'fy-preview-host-'));
  let result: Awaited<ReturnType<typeof convert>>;
  try {
    result = await convert({
      from: staging,
      to: target,
      dryRun: false,
      lock: inputs.lock,
      now: inputs.now,
      host: { homeDirectory: emptyHost, env: {} },
      steps: stepPlan().run,
      preview: true,
      previewV4Home: v4Home,
      previewShellEnv: previewShellEnv(target, PREVIEW.port),
    });
  } finally {
    await rm(emptyHost, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }

  const after = await snapshot(v4Home, facts);
  const proof = compare(before, after);
  if (result.kind === 'refused')
    return {
      report: undefined,
      summary: `refused; nothing was written:\n${result.problems.map(p => `  - ${p}`).join('\n')}`,
      proof,
      changedWhileCopying: staged.changed,
      gate: [],
    };
  if (!result.report.complete) {
    await rm(target, { recursive: true, force: true });
    return {
      report: result.report,
      summary: `${summarise(result.report)}\nthe conversion did not finish; the unfinished home was removed`,
      proof,
      changedWhileCopying: staged.changed,
      gate: [],
    };
  }
  // The empty folder a ferret that lost its v4 folder points at.
  await mkdir(join(target, PREVIEW_WORKSPACE), { recursive: true, mode: 0o700 });
  const gate = await gateFiles(target, v4Home, home, { v4Given: inputs.v4Given, homeGiven: [process.env.HOME ?? ''] });
  if (gate.length > 0) {
    await rm(target, { recursive: true, force: true });
    return {
      report: result.report,
      summary: `refused: ${gate.length} executed or path field(s) of the converted home name v4's home, its worktree folder or a harness home; it was removed:\n${gate.map(name => `  - ${name}`).join('\n')}`,
      proof,
      changedWhileCopying: staged.changed,
      gate,
    };
  }
  // Outside the preview home (its ferrets run as you and could rewrite a proof kept there) and outside every v4 path.
  await writeProof(home, target, v4Home, before);
  await writeFile(join(target, PREVIEW_MARKER), PREVIEW_MARKER_TEXT, { mode: 0o600 });
  return {
    report: result.report,
    summary: summarise(result.report),
    proof,
    changedWhileCopying: staged.changed,
    gate,
  };
}

/**
 * `preview.sh proof`: compares v4 now with the snapshot `prepare` took before it started. Run it after a start and a
 * stop. A config file you edited yourself in v4 since then shows up too; names only, never a value.
 */
export async function proofNow(v4Home: string, target: string, home: string = homedir()): Promise<Verdict> {
  const guarded = guardTarget(v4Home, target, home);
  if (!hasMarker(guarded.target)) throw new Error(`${guarded.target} is not a preview home made by prepare`);
  const proofPath = proofPathFor(home, guarded.target);
  const saved = await readFile(proofPath, 'utf8').catch(() => {
    throw new Error(`${proofPath} is missing: prepare did not finish, or the proof was removed`);
  });
  const facts: HostFacts = { userHome: home, runtimeDir: process.env.XDG_RUNTIME_DIR, uid: process.getuid?.() };
  return compare(parseSnapshot(saved), await snapshot(guarded.v4Home, facts));
}

/** Removes the preview home and its staging copy, and only a folder `prepare` marked. Returns what it removed. */
export async function cleanPreview(v4Home: string, target: string, home: string = homedir()): Promise<string> {
  const guarded = guardTarget(v4Home, target, home);
  if (!hasMarker(guarded.target))
    throw new Error(
      `${guarded.target} has no ${PREVIEW_MARKER} marker, so it is not a preview home; nothing was removed. If a prepare died before its marker, remove it yourself: rm -rf '${guarded.target}' '${guarded.staging}'`,
    );
  await rm(guarded.target, { recursive: true, force: true });
  await rm(guarded.staging, { recursive: true, force: true });
  await removeProof(home, guarded.target);
  return `removed ${guarded.target}, its staging copy and its proof`;
}

/** Names the wrapper passes through from the caller's environment (and `LC_*`): nothing else reaches the binary. */
export const ENV_ALLOWLIST = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'LANG',
  'XDG_RUNTIME_DIR',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK',
] as const;

/** Daemon verbs the preview never runs through the product's lifecycle: they write claim files beside v4's unit or answer for it. */
export const REFUSED_DAEMON_VERBS = [
  'stop',
  'restart',
  'update',
  'install',
  'uninstall',
  'reset',
  'which',
  'logs',
] as const;

/** The programs the preview ships: raw in `<home>/libexec`, with a pinning shim of the same name in `<home>/bin`. */
export const PREVIEW_PROGRAMS = ['fy', 'fyd', 'fyd-browser-worker'] as const;

const assertPlain = (path: string, what: string): void => {
  if (/["$`\\\n:]/u.test(path))
    throw new Error(`${what} must not contain a quote, $, backtick, backslash, colon or newline`);
};

/** `<home>/bin/<name>`: pins the preview home, port and address, then runs the preview's own raw program. */
export function shimText(home: string, name: (typeof PREVIEW_PROGRAMS)[number]): string {
  assertPlain(home, 'the preview home');
  const url = `http://127.0.0.1:${PREVIEW.port}`;
  return [
    '#!/bin/sh',
    `# ${name}: the 5.0 preview's own program. Generated; it pins the preview home and address so it never falls back to v4's.`,
    `exec env FY_HOME="${home}" FY_PORT="${PREVIEW.port}" FY_URL="${url}" "${home}/libexec/${name}" "$@"`,
    '',
  ].join('\n');
}

/** The one place the `fy5` wrapper's text is made, so a test and the shell entry agree. */
export function wrapperText(home: string, v4Home: string): string {
  assertPlain(home, 'the preview home');
  assertPlain(v4Home, "v4's home");
  const url = `http://127.0.0.1:${PREVIEW.port}`;
  const refused = REFUSED_DAEMON_VERBS.map(verb => `daemon:${verb}`).join('|');
  return [
    '#!/bin/sh',
    "# fy5: the 5.0 preview CLI. Generated; it sets the preview home, port and address, never v4's.",
    '# shellcheck disable=SC2154 # "value" is assigned through eval below',
    'set -eu',
    "# The daemon (`daemon start`, and the start check's `__daemon-probe <command>`, which runs <command> in the daemon's",
    '# exact environment) gets NO reachable user systemd manager: XDG_RUNTIME_DIR is a private folder of the preview home and',
    "# DBUS_SESSION_BUS_ADDRESS is dropped, so 5.0 launches directly and never reconfigures v4's systemd slices. Every other",
    '# verb (`pair`, `status`, ...) keeps both.',
    'daemon=0; probe=0; verb=""; sub=""',
    'if [ "${1:-}" = "__daemon-probe" ]; then',
    '  daemon=1; probe=1; shift',
    'else',
    '  # The verb is the first word that is not a flag, the subcommand the next.',
    '  for word in "$@"; do',
    '    case "$word" in',
    '    -*) ;;',
    '    *)',
    '      if [ -z "$verb" ]; then verb="$word"; else sub="$word"; break; fi',
    '      ;;',
    '    esac',
    '  done',
    '  case "$verb" in',
    '  update)',
    '    echo "fy5 does not run update: it would swap programs and restart under v4\'s service unit." >&2',
    '    exit 64',
    '    ;;',
    '  esac',
    '  case "$verb:$sub" in',
    `  ${refused})`,
    '    echo "fy5 does not run this daemon verb: it answers for v4\'s service unit or writes claim files beside it." >&2',
    '    echo "Use the preview script instead: preview.sh start | stop | status | clean." >&2',
    '    exit 64',
    '    ;;',
    '  daemon:start) daemon=1 ;;',
    '  esac',
    'fi',
    "# PATH: the preview's own bin first (every bare fy, fyd and fyd-browser-worker is then the preview's), and nothing",
    "# under v4's home or its worktree folder.",
    `path="${home}/bin"`,
    'set -f',
    'old_ifs="$IFS"; IFS=:',
    'for entry in ${PATH:-}; do',
    '  case "$entry" in',
    `  ""|"${home}/bin"|"${v4Home}"|"${v4Home}"/*|"${v4Home}-worktrees"|"${v4Home}-worktrees"/*) ;;`,
    '  *) path="$path:$entry" ;;',
    '  esac',
    'done',
    'IFS="$old_ifs"; set +f',
    'PATH="$path"',
    '# Nothing from a v4 ferret or the surrounding shell may reach the preview: the binary runs in an EMPTY environment',
    '# that holds only the allowlist below, and the preview home, port and address. FY_*, CLAUDE_*, CODEX_* never pass.',
    `if [ "$probe" = 0 ]; then set -- "${home}/libexec/fy" "\$@"; fi`,
    `for name in ${ENV_ALLOWLIST.join(' ')} $(env | sed -n 's/^\\(LC_[A-Za-z0-9_]*\\)=.*/\\1/p'); do`,
    '  case "$daemon:$name" in 1:XDG_RUNTIME_DIR|1:DBUS_SESSION_BUS_ADDRESS) continue ;; esac',
    '  if eval "[ \\"\\${$name+set}\\" = set ]"; then',
    '    eval "value=\\${$name}"',
    '    set -- "$name=$value" "$@"',
    '  fi',
    'done',
    'if [ "$daemon" = 1 ]; then',
    `  run="${home}/${PREVIEW.xdgRunFolder}"`,
    '  (umask 077; mkdir -p "$run"); chmod 700 "$run"',
    '  set -- "XDG_RUNTIME_DIR=$run" "$@"',
    'fi',
    `exec env -i FY_HOME="${home}" FY_PORT="${PREVIEW.port}" FY_URL="${url}" FY_UPDATE_CHECK=off "$@"`,
    '',
  ].join('\n');
}

export async function ensureFolder(path: string): Promise<void> {
  if ((await stat(path).catch(() => undefined)) === undefined) await mkdir(path, { recursive: true, mode: 0o700 });
}
