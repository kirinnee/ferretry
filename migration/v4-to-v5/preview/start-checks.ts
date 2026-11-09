/**
 * The read-only checks `preview.sh start` runs BEFORE it starts the preview daemon, and refuses to start when one fails.
 * Nothing here changes anything: each is a question put to the host with the exact environment the preview will use.
 *
 * 1. NO USER SYSTEMD MANAGER (MAJOR-A). 5.0 does not read `limits.yaml` for launches (Ferrets offers no
 *    `effectiveLimits`, so Terminals launches with the defaults), and with those defaults a daemon that can reach the
 *    user manager runs `systemctl --user set-property --runtime ferretry_fleet.slice ...` and the same on each ferret's
 *    slice: names v4's live daemon uses too. 5.0 falls back to direct execution only when its probe
 *    (`systemctl --user show-environment`, packages/plugins/terminals/daemon/lib/cgroups/enforcement.ts) fails. That
 *    probe is spawned by the kernel with only {PATH, HOME} (host/adapters/process.ts), so it is given no bus at all: that
 *    is the first layer. The second: `fy5 daemon start` sets XDG_RUNTIME_DIR to a private folder of the preview home and
 *    drops DBUS_SESSION_BUS_ADDRESS. This check asks the probe BOTH ways, as the kernel runs it ({PATH, HOME}) and in
 *    the daemon's exact environment (through `fy5 __daemon-probe`, the one place the wrapper builds it), and refuses to
 *    start if either reaches a manager.
 * 2. LOGIN SHELLS FIND THE PREVIEW'S `fy` (MAJOR-B). With the guard environment a preview ferret's shells get
 *    (`src/v5/preview-env.ts`), `bash -lc` and `zsh -lic` must resolve `fy` to the preview's shim, not to v4's.
 */
import { join } from 'node:path';
import { previewShellEnv } from '../src/v5/preview-env.ts';
import { PREVIEW } from './plan.ts';

/** What running a program answered. `code` is `undefined` when it could not even be started. */
export interface RunResult {
  readonly code: number | undefined;
  readonly stdout: string;
}

/** Runs `argv` in exactly `env` (an empty environment plus `env`, never the caller's). */
export type Run = (argv: readonly string[], env: Readonly<Record<string, string>>) => Promise<RunResult>;

export interface StartChecksInput {
  readonly target: string;
  readonly v4Home: string;
  /** The caller's own environment: only HOME, USER and PATH are read from it. */
  readonly callerEnv: Readonly<Record<string, string | undefined>>;
  readonly run: Run;
}

export interface StartChecks {
  readonly ok: boolean;
  /** One sentence each, naming what was found and what to do. */
  readonly problems: readonly string[];
  /** What was checked and passed, for the owner to read. */
  readonly passed: readonly string[];
}

/** The login and interactive shells a preview ferret may run, as the flags that make them read the profile files. */
export const LOGIN_SHELLS: readonly { readonly shell: string; readonly flags: string }[] = [
  { shell: 'bash', flags: '-lc' },
  { shell: 'zsh', flags: '-lic' },
  // Claude's Bash tool sources the rc file, which `bash -lc` reads only when `.profile` does.
  { shell: 'bash', flags: '-ic' },
];

/** PATH as `fy5` builds it: the preview's own `bin` first, nothing under v4's home or its worktree folder. */
export function previewPath(target: string, v4Home: string, callerPath: string | undefined): string {
  const keep = (callerPath ?? '')
    .split(':')
    .filter(
      entry =>
        entry !== '' &&
        entry !== join(target, 'bin') &&
        !(entry === v4Home || entry.startsWith(`${v4Home}/`)) &&
        !(entry === `${v4Home}-worktrees` || entry.startsWith(`${v4Home}-worktrees/`)),
    );
  return [join(target, 'bin'), ...keep].join(':');
}

/** The named variables of `env` that are set. */
const pick = (env: Readonly<Record<string, string | undefined>>, names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.flatMap(name => (env[name] === undefined ? [] : [[name, env[name] as string]])));

export async function startChecks(input: StartChecksInput): Promise<StartChecks> {
  const { target, v4Home, callerEnv, run } = input;
  const problems: string[] = [];
  const passed: string[] = [];
  const fy5 = join(target, 'bin', PREVIEW.wrapper);

  // 1a. The wrapper builds the daemon's environment: prove it is the one this check reasons about. The caller's own
  // runtime folder and session bus are PASSED IN on purpose: the wrapper must replace them, as it does for the daemon.
  const asCaller = pick(callerEnv, ['HOME', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']);
  const wanted = `${join(target, PREVIEW.xdgRunFolder)}|unset`;
  const environment = await run(
    [
      fy5,
      '__daemon-probe',
      'sh',
      '-c',
      'printf "%s|%s" "${XDG_RUNTIME_DIR-unset}" "${DBUS_SESSION_BUS_ADDRESS-unset}"',
    ],
    asCaller,
  );
  if (environment.code !== 0 || environment.stdout.trim() !== wanted) {
    problems.push(
      `refusing to start: ${fy5} did not give the daemon the private runtime folder and no session bus (it answered "${environment.stdout.trim()}", expected "${wanted}"). Run preview.sh prepare again, or fix the wrapper.`,
    );
  } else {
    passed.push('the daemon environment has a private XDG_RUNTIME_DIR and no DBUS_SESSION_BUS_ADDRESS');
    // 1b. The 5.0 probe, in that environment, must NOT reach a manager.
    const manager = await run([fy5, '__daemon-probe', 'systemctl', '--user', 'show-environment'], asCaller);
    if (manager.code === 0)
      problems.push(
        "refusing to start: with the preview daemon's exact environment `systemctl --user show-environment` still reaches your user systemd manager, so the preview would reconfigure v4's live `ferretry_fleet.slice` and its per-ferret slices (5.0 does not read limits.yaml for launches). Nothing was started.",
      );
    else passed.push('no user systemd manager is reachable from the preview daemon (launches run directly, no slice)');
  }
  // 1c. The probe as the kernel really runs it: only {PATH, HOME} (the daemon's PATH), no bus. Asked outside the wrapper.
  const kernelEnv = { ...pick(callerEnv, ['HOME']), PATH: previewPath(target, v4Home, callerEnv.PATH) };
  const kernel = await run(['systemctl', '--user', 'show-environment'], kernelEnv);
  if (kernel.code === 0)
    problems.push(
      "refusing to start: `systemctl --user show-environment` with only {PATH, HOME} (the environment the kernel gives 5.0's systemd probe) reaches your user systemd manager, so the preview would reconfigure v4's live `ferretry_fleet.slice` and its per-ferret slices. Nothing was started.",
    );
  else passed.push('the kernel-environment probe ({PATH, HOME}) reaches no user systemd manager');

  // 2. Login and interactive shells with the guard environment must find the preview's own fy.
  const shimFy = join(target, 'bin', 'fy');
  const shellEnv = {
    ...pick(callerEnv, ['HOME', 'USER']),
    PATH: previewPath(target, v4Home, callerEnv.PATH),
    ...previewShellEnv(target, PREVIEW.port),
  };
  let probed = 0;
  for (const { shell, flags } of LOGIN_SHELLS) {
    const found = await run([shell, flags, 'command -v fy'], shellEnv);
    if (found.code === undefined) {
      passed.push(`${shell} is not installed here: its login shell was not probed`);
      continue;
    }
    probed++;
    const answer = found.stdout.trim().split('\n').at(-1) ?? '';
    if (found.code !== 0 || answer !== shimFy)
      problems.push(
        `refusing to start: \`${shell} ${flags} 'command -v fy'\` with the guard environment finds ${answer === '' ? 'no fy' : answer}, not ${shimFy}. A preview ferret's login shell would run that fy against the wrong daemon. Remove or move the other fy, or extend the guard in src/v5/preview-env.ts.`,
      );
    else passed.push(`${shell} ${flags}: fy is the preview's (${shimFy})`);
  }
  if (probed === 0) problems.push('refusing to start: neither bash nor zsh could be probed for the preview fy.');
  return { ok: problems.length === 0, problems, passed };
}

/** The name of the terminal the check opens, and the word it prints last so a wait cannot match the typed line. */
export const CHECK_TERMINAL = 'fycheck';
const DONE_WORD = 'FYCHECK-DONE';

/** What the terminal is told to run: `command -v fy` and `$FY_HOME`, each on its own labelled line, then the done word. */
export const CHECK_COMMAND = `printf 'fy=%s\\nhome=%s\\n' "$(command -v fy)" "$FY_HOME"; printf '%s%s\\n' FYCHECK- DONE`;

export interface TerminalCheckInput extends StartChecksInput {
  /** Waits between tries while the daemon is still coming up; absent, the daemon is asked once. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const COMING_UP_TRIES = 15;

/**
 * 3. A TERMINAL THE PREVIEW DAEMON OPENS carries the preview environment (MAJOR-1). Run AFTER the daemon is up and only
 * inside the owner's real preview: it opens a terminal through the daemon's own route (`fy5 terminal open --ferret`, the
 * route the owner's web terminal uses; a ferret's tool opens it the same way), has it print `command -v fy` and
 * `$FY_HOME`, and requires the preview's shim and the preview home. A miss says so, and the terminal is closed either way.
 */
export async function terminalCheck(input: TerminalCheckInput): Promise<StartChecks> {
  const { target, callerEnv, run } = input;
  const fy5 = join(target, 'bin', PREVIEW.wrapper);
  const asCaller = pick(callerEnv, ['HOME', 'USER', 'PATH']);
  const problems: string[] = [];
  const passed: string[] = [];
  const refuse = (sentence: string): StartChecks => ({ ok: false, problems: [...problems, sentence], passed });

  let ferret: string | undefined;
  for (let attempt = 0; attempt < COMING_UP_TRIES && ferret === undefined; attempt++) {
    const listed = await run([fy5, 'ps', '--json'], asCaller);
    if (listed.code === 0) {
      try {
        const rows: unknown = JSON.parse(listed.stdout);
        const first = Array.isArray(rows) ? (rows[0] as { id?: unknown } | undefined) : undefined;
        if (typeof first?.id === 'string') ferret = first.id;
      } catch {
        // an answer that is not JSON is read as no ferret below
      }
      break;
    }
    if (input.sleep !== undefined && attempt < COMING_UP_TRIES - 1) await input.sleep(1_000);
    else break;
  }
  if (ferret === undefined)
    return refuse(
      `could not prove the terminal environment: ${fy5} ps --json gave no ferret to open a terminal under (the preview daemon is not answering, or the preview has no ferret yet). Start a Claude ferret with ${fy5} start, then run preview.sh terminal-check.`,
    );

  const opened = await run([fy5, 'terminal', 'open', CHECK_TERMINAL, '--ferret', ferret, CHECK_COMMAND], asCaller);
  try {
    if (opened.code !== 0)
      return refuse(
        `could not prove the terminal environment: the preview daemon refused to open a terminal (${fy5} terminal open answered ${String(opened.code)}).`,
      );
    await run(
      [fy5, 'terminal', 'wait', CHECK_TERMINAL, '--ferret', ferret, '--text', DONE_WORD, '--timeout', '20000'],
      asCaller,
    );
    const read = await run([fy5, 'terminal', 'read', CHECK_TERMINAL, '--ferret', ferret, '--lines', '40'], asCaller);
    const found = /^fy=(.*)$/mu.exec(read.stdout)?.[1]?.trim() ?? '';
    const home = /^home=(.*)$/mu.exec(read.stdout)?.[1]?.trim() ?? '';
    const shim = join(target, 'bin', 'fy');
    if (read.code !== 0 || found !== shim || home !== target)
      return refuse(
        `refusing to go on: a terminal the preview daemon opened found fy at ${found === '' ? 'nowhere' : found} and FY_HOME ${home === '' ? 'unset' : home}, not ${shim} and ${target}. A terminal you or a ferret opens would run v4's fy against v4's home. The terminal was closed. Check \`environment\` in ${join(target, 'config', 'terminals.yaml')}, then run preview.sh terminal-check.`,
      );
    passed.push(`a terminal the preview daemon opened finds the preview's fy (${shim}) and FY_HOME ${target}`);
    return { ok: true, problems, passed };
  } finally {
    await run([fy5, 'terminal', 'close', CHECK_TERMINAL, '--ferret', ferret], asCaller);
  }
}
