/**
 * `fy gh -- <args>` (r9 B10): Ferretry's `gh`, as seen from inside a ferret. The `gh` shim on the pane's `PATH` calls it.
 * It sends the arguments and the folder to the daemon (`POST /v1/git-accounts/gh/run`, B9) and prints what comes back:
 * stdout, stderr and `gh`'s own exit code. The daemon alone decides (account, repository, which commands run); there is no
 * second policy here, so nothing here can widen it.
 *
 * What it does NOT send: stdin and files the argv names. B9's run seam refuses every flag that reads a local file, so
 * there is nothing to send them to (a declared GAP, docs/secrets.md "Ferretry's gh").
 */
import type { CliContext, VerbHandler, VerbInvocation } from '@ferretry/kernel/manifest';
import { type GhRunAnswer, GhRunAnswerSchema } from '../contract/index.ts';
import type manifest from '../manifest.ts';
import { isRegularFile } from './adapters/regular-file.ts';

const OK = 0;
const FAILED = 1;
const USAGE = 2;
/** `gh` was ended by a signal (its time ran out): the same code a shell reports for a timeout. */
const TIMED_OUT = 124;

/** The names `fy gh-doctor` reads (`permissions.cliEnvReads`): never a value is printed. */
export const GH_DOCTOR_ENV = ['PATH', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'] as const;
const TOKEN_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'] as const;

/**
 * How long `fy gh` waits for the daemon: the daemon's longest run (a followed `gh pr checks --watch`, 5 minutes) plus a
 * margin, so the transport's own 60 s never ends a run the daemon is still allowed to finish.
 */
const GH_REQUEST_MS = 330_000;

interface Typed {
  /** `gh`'s own words, and nothing of `fy`'s: no `--account`, not the outer `--`. */
  readonly argv: readonly string[];
  readonly account: string | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/**
 * What was typed, split into `fy gh`'s own option (`--account <login>`) and `gh`'s words. With a `--` (the shim always writes
 * one) everything before the FIRST `--` is `fy`'s and everything after it is `gh`'s, byte for byte, even a word that looks
 * like `--account`. Without one, only a leading `--account` is `fy`'s. The daemon is sent `gh`'s argv alone.
 */
function typedWords(invocation: VerbInvocation): Typed {
  if (invocation.words === undefined) {
    const value = invocation.options['account'];
    return { argv: invocation.args, account: typeof value === 'string' ? nonEmpty(value) : undefined };
  }
  const words = invocation.words;
  const outer = words.indexOf('--');
  let account: string | undefined;
  let at = 0;
  // `fy`'s own words: all of them before a `--`, otherwise only the leading `--account` ones.
  while (at < (outer < 0 ? words.length : outer)) {
    const word = words[at] as string;
    if (word === '--account') {
      // The word after it is its value, unless that word is the outer `--` (an `--account` with no value).
      const value = words[at + 1] === '--' ? undefined : words[at + 1];
      account = nonEmpty(value);
      at += value === undefined ? 1 : 2;
    } else if (word.startsWith('--account=')) {
      account = nonEmpty(word.slice('--account='.length));
      at += 1;
    } else if (outer < 0) break;
    else at += 1;
  }
  return { argv: words.slice(outer < 0 ? at : outer + 1), account };
}

const NAMES_HEAD = (argv: readonly string[]): boolean =>
  argv.some(arg => arg === '-H' || arg === '--head' || arg.startsWith('--head='));
/** `ref: refs/heads/<branch>`, and a branch name that cannot be taken for a flag or carry a shell or path trick. */
const BRANCH = /^ref: refs\/heads\/([A-Za-z0-9._][A-Za-z0-9._/-]{0,199})$/u;

const GITDIR_LINE = /^gitdir: (.+)$/mu;
/** A `.git` file or a `HEAD` is a line or two: read no more than this much of either. */
const MAX_GIT_TEXT = 4096;

/**
 * What `withHead` asks of the disk beyond the context's own reads: whether a path is a regular file. A `.git` file or a
 * `HEAD` that is a FIFO would block the read for good (opening one waits for a writer), so only a regular file is read.
 */
export interface GhPorts {
  readonly isRegularFile: (path: string) => Promise<boolean>;
}

const REAL_PORTS: GhPorts = { isRegularFile };

/** `path` read as text (at most {@link MAX_GIT_TEXT} bytes), or `''` when it is not a regular file or cannot be read. */
const gitText = async (
  path: string,
  files: Pick<CliContext<typeof manifest>, 'readText'>,
  ports: GhPorts,
): Promise<string> => {
  if (!(await ports.isRegularFile(path))) return '';
  return ((await files.readText?.(path, MAX_GIT_TEXT).catch(() => '')) ?? '').slice(0, MAX_GIT_TEXT);
};

const branchIn = async (
  head: string,
  files: Pick<CliContext<typeof manifest>, 'readText'>,
  ports: GhPorts,
): Promise<string | undefined> => BRANCH.exec((await gitText(head, files, ports)).trim())?.[1];

/**
 * `gh pr create` runs in an empty folder on the daemon and cannot see the ferret's branch (B9), so THIS side, which runs as
 * the ferret in its own folder, names it: the branch `.git/HEAD` says, read as text. Anything else (no repository above,
 * a detached HEAD, an odd name) leaves the argv alone and the daemon says "pass --head <branch>".
 */
async function withHead(
  argv: readonly string[],
  cwd: string,
  files: Pick<CliContext<typeof manifest>, 'exists' | 'readText'>,
  ports: GhPorts,
): Promise<readonly string[]> {
  if (argv[0] !== 'pr' || argv[1] !== 'create' || NAMES_HEAD(argv)) return argv;
  if (files.exists === undefined || files.readText === undefined) return argv;
  let folder = cwd;
  for (let up = 0; up < 8; up += 1) {
    const dot = `${folder === '/' ? '' : folder}/.git`;
    if (await files.exists(`${dot}/HEAD`)) {
      const branch = await branchIn(`${dot}/HEAD`, files, ports);
      return branch === undefined ? argv : [...argv, '--head', branch];
    }
    // A linked WORKTREE has a `.git` FILE: `gitdir: <main>/.git/worktrees/<name>`, and that folder's `HEAD` is THIS worktree's branch
    // (never the main checkout's, which is what climbing to the parent would name). Read as text, no `git` run.
    const pointer = GITDIR_LINE.exec(await gitText(dot, files, ports))?.[1]?.trim();
    if (pointer !== undefined) {
      const gitdir = pointer.startsWith('/') ? pointer : `${folder === '/' ? '' : folder}/${pointer}`;
      const branch = await branchIn(`${gitdir.replace(/\/+$/u, '')}/HEAD`, files, ports);
      return branch === undefined ? argv : [...argv, '--head', branch];
    }
    if (folder === '/' || folder === '') break;
    folder = folder.slice(0, Math.max(folder.lastIndexOf('/'), 0)) || '/';
  }
  return argv;
}

export function ghVerbs(
  context: CliContext<typeof manifest>,
  ports: GhPorts = REAL_PORTS,
): {
  readonly gh: VerbHandler;
  readonly 'gh-doctor': VerbHandler;
} {
  const { client, io } = context;
  return {
    gh: async invocation => {
      const { argv: typedArgv, account } = typedWords(invocation);
      if (typedArgv.length === 0) {
        io.err('gh needs a command, for example: gh pr list\n');
        return USAGE;
      }
      const cwd = context.env?.['PWD'];
      if (cwd === undefined || !cwd.startsWith('/')) {
        io.err("Ferretry's gh could not tell which folder you are in, so it cannot choose an account.\n");
        return FAILED;
      }
      const argv = await withHead(typedArgv, cwd, context, ports);
      const answer: GhRunAnswer = GhRunAnswerSchema.parse(
        await client.call<unknown>('POST /v1/git-accounts/gh/run', {
          body: { argv, cwd, ...(account === undefined ? {} : { account }) },
          timeoutMs: GH_REQUEST_MS,
        }),
      );
      if ('refused' in answer) {
        io.err(`${answer.refused}\n`);
        return FAILED;
      }
      if (answer.stdout !== '') io.out(answer.stdout);
      if (answer.stderr !== '') io.err(answer.stderr);
      return answer.exitCode ?? TIMED_OUT;
    },

    // The pane-side check: the first `gh` on this pane's PATH is Ferretry's shim, and no GitHub token sits in the pane.
    'gh-doctor': async () => {
      const seen = context.readEnvironment?.(GH_DOCTOR_ENV) ?? {};
      const problems: string[] = [];
      const tokens = TOKEN_NAMES.filter(name => seen[name] !== undefined && seen[name] !== '');
      if (tokens.length > 0)
        problems.push(
          `${tokens.join(', ')} ${tokens.length === 1 ? 'is' : 'are'} set in this terminal. Ferretry never sets one; remove it from the shell rc or the login's environment so \`gh\` cannot use it.`,
        );
      const config = seen['GH_CONFIG_DIR'];
      const expected = config === undefined ? undefined : `${config.slice(0, config.lastIndexOf('/'))}/shims/gh`;
      let first: string | undefined;
      for (const folder of (seen['PATH'] ?? '').split(':')) {
        if (folder === '' || !folder.startsWith('/')) continue;
        if (await (context.exists?.(`${folder}/gh`) ?? Promise.resolve(false))) {
          first = `${folder}/gh`;
          break;
        }
      }
      if (expected === undefined || !config?.endsWith('/pane-gh-config'))
        problems.push(
          "This terminal was not started with Ferretry's gh shim (GH_CONFIG_DIR is not Ferretry's). Restart the ferret; if it persists, run `fy doctor`.",
        );
      else if (first !== expected)
        problems.push(
          first === undefined
            ? "No `gh` is first on PATH in this terminal, so Ferretry's shim cannot be used."
            : `\`command -v gh\` is ${first}, not Ferretry's shim (${expected}): a shell rc has moved PATH. Put ${expected.slice(0, expected.lastIndexOf('/'))} back first.`,
        );
      if (problems.length === 0) {
        io.out("OK: `gh` in this terminal is Ferretry's shim and no GitHub token is set.\n");
        return OK;
      }
      for (const problem of problems) io.err(`warning: ${problem}\n`);
      return FAILED;
    },
  };
}
