/**
 * 4. THE PREVIEW DAEMON REACHES NO HOST CREDENTIAL. Run AFTER the daemon is up (`preview.sh start` stops the daemon on any
 * miss). The preview once found the owner's real `gh` on its PATH and used the owner's login to poll GitHub (!A469).
 * `fy5` is the ONE place the daemon's environment is built (`driver.ts`, an allow-list); this check puts the same
 * environment to the proof, through `fy5 __daemon-probe`, and reads NAMES only, never a value:
 *
 *  - no variable of the daemon's environment has a credential-shaped name (`*_TOKEN`, `AWS_*`, `GH_*`, ...);
 *  - HOME, GH_CONFIG_DIR and GIT_CONFIG_GLOBAL are the preview's own, and the folders are EMPTY (the HOME and the gh folder hold nothing; zdot/ holds one empty .zshrc and, by name only, a shell's own state files), with mode 0700 / 0600, and none is a link;
 *  - git reads no system config and never prompts; there is no SSH agent socket;
 *  - `ssh -G`, run in the environment a CHILD of the daemon gets (the kernel's PATH and HOME only), shows `identityfile none`:
 *    the wrapper's `ssh` shim is first on that PATH;
 *  - `gh auth status`, run in that environment, says the daemon is NOT logged in (when a `gh` is on its PATH at all). A
 *    `gh` that is `<home>/bin/gh` is the preview's own (the gh stub) and is accepted without being asked.
 */
import { join } from 'node:path';
import { HOME_SHELL_RC, NO_CREDS_ENV, noCredsValues, SHELL_STATE_NAMES } from './driver.ts';
import { PREVIEW } from './plan.ts';
import type { Run, StartChecks } from './start-checks.ts';

/** Names that look like a credential, wherever they come from. The first match is the reason. */
const CREDENTIAL_NAMES: readonly RegExp[] = [
  /_(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIALS?)$/u,
  /^(GH|GITHUB|GIT|SSH|AWS|AZURE|GOOGLE|GCLOUD|NPM|DOCKER|ANTHROPIC|OPENAI|CLAUDE|CODEX)_/u,
  /^(GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK)$/u,
];

/** The credential-shaped names the wrapper sets ON PURPOSE, each checked for its exact preview value below. */
const SET_ON_PURPOSE = new Set(Object.keys(noCredsValues('/x')));

/** The names of `env -0` output that look like a credential and are not one the wrapper itself set. Names only. */
export const credentialNames = (names: readonly string[]): string[] =>
  names.filter(name => !SET_ON_PURPOSE.has(name) && CREDENTIAL_NAMES.some(pattern => pattern.test(name)));

/** What a path is, for the emptiness proof (`undefined`: nothing there). */
export interface Inspected {
  readonly kind: 'dir' | 'file' | 'other';
  readonly mode: number;
  readonly size: number;
  readonly entries: number;
  /** The entry NAMES of a folder (never a content); a name is all the check reads of a shell's own state files. */
  readonly names?: readonly string[];
}

export interface CredentialCheckInput {
  readonly target: string;
  readonly callerEnv: Readonly<Record<string, string | undefined>>;
  readonly run: Run;
  readonly inspect: (path: string) => Promise<Inspected | undefined>;
  /**
   * The RUNNING daemon's own environment as NUL-separated `NAME=value` text (`/proc/<pid>/environ`), or `undefined` where
   * there is no such file (macOS) or no daemon holds the lock. Read only for names and the wrapper's fixed values.
   */
  readonly daemonEnviron?: () => Promise<string | undefined>;
  /** The kernel's own rule for what a child of the daemon gets (`childEnvironment`), given the daemon's PATH and HOME. */
  readonly childEnvironment: (
    program: string,
    base: Readonly<Record<string, string>>,
  ) => Readonly<Record<string, string>>;
}

/** An alias no config names: with `-F /dev/null` ssh -G prints it back unchanged as the host name. */
const SSH_CHECK_ALIAS = 'fy-preview-ssh-check.invalid';

/** The environment `fy5 daemon start` is given by `preview.sh`: the caller's WHOLE environment, never a trimmed copy. */
const wholeEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])));

/** The environment text of the process that holds the preview's daemon lock; `undefined` when there is none to read. */
export async function readDaemonEnviron(
  lockFile: string,
  ports: {
    readonly holders: (lockFile: string) => Promise<readonly number[]>;
    readonly environOf: (pid: number) => Promise<string | undefined>;
  },
): Promise<string | undefined> {
  const [pid] = await ports.holders(lockFile);
  return pid === undefined ? undefined : ports.environOf(pid);
}

export async function credentialCheck(input: CredentialCheckInput): Promise<StartChecks> {
  const { target, callerEnv, run, inspect } = input;
  const fy5 = join(target, 'bin', PREVIEW.wrapper);
  // The probes run in the caller's WHOLE environment, as `preview.sh` gives `fy5 daemon start`, so a name the wrapper's
  // allow-list lets through that the caller holds is seen here exactly as the daemon had it.
  const asCaller = wholeEnv(callerEnv);
  const problems: string[] = [];
  const passed: string[] = [];
  const probe = (argv: readonly string[]) => run([fy5, '__daemon-probe', ...argv], asCaller);

  // 1. The daemon's own environment, read as names and the fixed values the wrapper sets (a value is never printed): from
  // the running daemon's /proc/<pid>/environ where it exists, else from the wrapper's probe in the caller's environment.
  let environ = await input.daemonEnviron?.();
  if (environ === undefined) {
    const printed = await probe(['env', '-0']);
    if (printed.code !== 0)
      return {
        ok: false,
        problems: [
          `could not read the daemon's environment: ${fy5} __daemon-probe env answered ${String(printed.code)}.`,
        ],
        passed,
      };
    environ = printed.stdout;
  }
  // A VALUE is kept only for the names the wrapper sets (compared with the preview's own, never printed) and for PATH, which
  // only builds the child environment below. Every other name goes into a names-only set: its value is dropped here.
  const entries = environ
    .split('\0')
    .filter(entry => entry.includes('='))
    .map((entry): [string, string] => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]);
  const names = new Set(entries.map(([name]) => name));
  const have = new Map(entries.filter(([name]) => SET_ON_PURPOSE.has(name)));
  const daemonPath = entries.find(([name]) => name === 'PATH')?.[1] ?? '';
  const named = credentialNames([...names]);
  if (named.length > 0)
    problems.push(
      `refusing to go on: the preview daemon's environment carries credential-shaped variables (${named.join(', ')}); a child of the daemon could use your sign-in. Fix the wrapper's allow-list (preview/driver.ts ENV_ALLOWLIST).`,
    );
  const wanted = noCredsValues(target);
  const wrong = Object.keys(wanted).filter(name => have.get(name) !== wanted[name]);
  if (wrong.length > 0)
    problems.push(
      `refusing to go on: the preview daemon's environment does not hold the preview's own ${wrong.join(', ')} (it must be the empty ones under ${join(target, PREVIEW.noCredsFolder)}). Run preview.sh prepare again, or fix the wrapper.`,
    );
  if (named.length === 0 && wrong.length === 0)
    passed.push('the preview daemon environment carries no credential-shaped variable and no SSH agent');

  // 2. What stands in the credentials' place is EMPTY and private.
  const base = join(target, PREVIEW.noCredsFolder);
  const folderProblems: string[] = [];
  // The HOME and the gh folder hold nothing. The terminals' ZDOTDIR folder (zdot/) holds the one empty 0600 shell rc the
  // wrapper makes (so zsh's first-run menu does not swallow the keys typed into a terminal), and may hold, by NAME only,
  // the files a terminal's shell wrote after the proof; any other name is a miss. A link is never a folder or a file here.
  const home = await inspect(join(base, NO_CREDS_ENV.home));
  if (home === undefined || home.kind !== 'dir' || home.mode !== 0o700 || home.entries !== 0)
    folderProblems.push(`${NO_CREDS_ENV.home}/ is not an empty 0700 folder`);
  const zdot = await inspect(join(base, NO_CREDS_ENV.zdot));
  const rc = await inspect(join(base, NO_CREDS_ENV.zdot, HOME_SHELL_RC));
  if (
    zdot === undefined ||
    zdot.kind !== 'dir' ||
    zdot.mode !== 0o700 ||
    rc === undefined ||
    rc.kind !== 'file' ||
    rc.mode !== 0o600 ||
    rc.size !== 0 ||
    (zdot.names ?? []).some(name => name !== HOME_SHELL_RC && !SHELL_STATE_NAMES.some(pattern => pattern.test(name)))
  )
    folderProblems.push(
      `${NO_CREDS_ENV.zdot}/ is not a 0700 folder holding one empty 0600 ${HOME_SHELL_RC} and nothing but a shell's own state files`,
    );
  const gh = await inspect(join(base, NO_CREDS_ENV.gh));
  if (gh === undefined || gh.kind !== 'dir' || gh.mode !== 0o700 || gh.entries !== 0)
    folderProblems.push(`${NO_CREDS_ENV.gh}/ is not an empty 0700 folder`);
  const git = await inspect(join(base, NO_CREDS_ENV.gitConfig));
  if (git === undefined || git.kind !== 'file' || git.mode !== 0o600 || git.size !== 0)
    folderProblems.push(`${NO_CREDS_ENV.gitConfig} is not an empty 0600 file`);
  if (folderProblems.length > 0)
    problems.push(
      `refusing to go on: under ${base}: ${folderProblems.join('; ')}. Run preview.sh stop, then start again.`,
    );
  else passed.push('the daemon HOME, gh config folder and git global config are empty and private');

  // 3. `gh` in that environment is NOT signed in (no gh on its PATH is fine: nothing to sign in with).
  const found = await probe(['sh', '-c', 'command -v gh']);
  const ownGh = join(target, 'bin', 'gh');
  if (found.code !== 0) passed.push('no `gh` on the preview daemon PATH');
  else if (found.stdout.trim() === ownGh)
    // The preview's OWN gh (the owner copied the gh stub there): a fake that answers for the watcher, never the host's.
    passed.push(`the \`gh\` on the preview daemon PATH is the preview's own (${ownGh}), not the host's`);
  else {
    const status = await probe(['gh', 'auth', 'status']);
    if (status.code === 0)
      problems.push(
        'refusing to go on: `gh auth status` in the preview daemon environment says it IS signed in, so the preview would use your GitHub sign-in. Nothing here says which account.',
      );
    else passed.push('`gh auth status` in the preview daemon environment says it is not signed in');
  }

  // 4. `ssh -G` in a CHILD of the daemon's environment, built by the kernel's own rule (PATH and HOME only: no
  // GIT_SSH_COMMAND reaches a child). The wrapper's `ssh` shim, first on that PATH, must have it read no user config and
  // offer no key: `identityfile none` and the alias unchanged. No `ssh` that starts at all is fine: nothing to read keys with.
  const child = input.childEnvironment('ssh', { PATH: daemonPath, HOME: wanted.HOME as string });
  const shown = await run(['ssh', '-G', SSH_CHECK_ALIAS], child);
  if (shown.code === undefined) passed.push('no `ssh` on the preview daemon PATH');
  else {
    const lines = shown.stdout.split('\n').map(line => line.trim());
    const identities = lines.filter(line => line.startsWith('identityfile '));
    if (
      shown.code === 0 &&
      identities.length === 1 &&
      identities[0] === 'identityfile none' &&
      lines.includes(`hostname ${SSH_CHECK_ALIAS}`)
    )
      passed.push(
        "`ssh` found on the daemon's PATH by a child of the preview daemon (the preview's shim) reads no user config and offers no key; a pane or launch that sets its own PATH, a program that calls /usr/bin/ssh by absolute path and one that names ~/.ssh by absolute path is not covered",
      );
    else
      problems.push(
        `refusing to go on: \`ssh -G ${SSH_CHECK_ALIAS}\` run with the environment a child of the preview daemon gets (PATH and HOME only) did not show \`identityfile none\` and the alias unchanged, so ssh there reads your ~/.ssh config and keys (exit ${String(shown.code)}). The preview's ssh shim (${join(target, PREVIEW.noCredsFolder, 'bin', 'ssh')}) is missing or not first on PATH. Run preview.sh stop, then start again.`,
      );
  }
  return { ok: problems.length === 0, problems, passed };
}
