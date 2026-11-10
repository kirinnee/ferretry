/**
 * 4. THE PREVIEW DAEMON REACHES NO HOST CREDENTIAL. Run AFTER the daemon is up (`preview.sh start` stops the daemon on any
 * miss). The preview once found the owner's real `gh` on its PATH and used the owner's login to poll GitHub (!A469).
 * `fy5` is the ONE place the daemon's environment is built (`driver.ts`, an allow-list); this check puts the same
 * environment to the proof, through `fy5 __daemon-probe`, and reads NAMES only, never a value:
 *
 *  - no variable of the daemon's environment has a credential-shaped name (`*_TOKEN`, `AWS_*`, `GH_*`, ...);
 *  - HOME, GH_CONFIG_DIR and GIT_CONFIG_GLOBAL are the preview's own, and the folders are EMPTY, with mode 0700 / 0600;
 *  - git reads no system config and never prompts; there is no SSH agent socket;
 *  - `gh auth status`, run in that environment, says the daemon is NOT logged in (when a `gh` is on its PATH at all). A
 *    `gh` that is `<home>/bin/gh` is the preview's own (the gh stub) and is accepted without being asked.
 */
import { join } from 'node:path';
import { NO_CREDS_ENV, noCredsValues } from './driver.ts';
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
}

export interface CredentialCheckInput {
  readonly target: string;
  readonly callerEnv: Readonly<Record<string, string | undefined>>;
  readonly run: Run;
  readonly inspect: (path: string) => Promise<Inspected | undefined>;
}

const pick = (env: Readonly<Record<string, string | undefined>>, names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.flatMap(name => (env[name] === undefined ? [] : [[name, env[name] as string]])));

export async function credentialCheck(input: CredentialCheckInput): Promise<StartChecks> {
  const { target, callerEnv, run, inspect } = input;
  const fy5 = join(target, 'bin', PREVIEW.wrapper);
  const asCaller = pick(callerEnv, ['USER', 'PATH']);
  const problems: string[] = [];
  const passed: string[] = [];
  const probe = (argv: readonly string[]) => run([fy5, '__daemon-probe', ...argv], asCaller);

  // 1. The daemon's own environment, read as names and the fixed values the wrapper sets (a value is never printed).
  const printed = await probe(['env', '-0']);
  if (printed.code !== 0)
    return {
      ok: false,
      problems: [
        `could not read the daemon's environment: ${fy5} __daemon-probe env answered ${String(printed.code)}.`,
      ],
      passed,
    };
  const have = new Map(
    printed.stdout
      .split('\0')
      .filter(entry => entry.includes('='))
      .map((entry): [string, string] => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
  );
  const named = credentialNames([...have.keys()]);
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
  const folders = [NO_CREDS_ENV.home, NO_CREDS_ENV.gh];
  const folderProblems: string[] = [];
  for (const name of folders) {
    const seen = await inspect(join(base, name));
    if (seen === undefined || seen.kind !== 'dir' || seen.mode !== 0o700 || seen.entries !== 0)
      folderProblems.push(`${name}/ is not an empty 0700 folder`);
  }
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
  return { ok: problems.length === 0, problems, passed };
}
