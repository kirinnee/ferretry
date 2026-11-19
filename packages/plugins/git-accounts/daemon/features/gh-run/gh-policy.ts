/**
 * What Ferretry's `gh` will be asked to do, decided on the argv alone (r9 B9). Pure: no disk, no account, no clock.
 *
 * This is the FRIENDLY layer in front of `GitAccountsApi.run`, whose own allow-list (`checkGhArgs`, B1) is narrower and
 * stays the authority: whatever passes here still has to pass there, so the effective surface is the intersection. What
 * this layer adds is the sentence. Every refusal says what to do instead, so an agent that was told "no" does not retry
 * the same thing a dozen ways. It is an allow-list of top-level commands and subcommands: an unknown name (a command a
 * later `gh` adds, an extension) is refused because nobody listed it.
 *
 * Verdicts:
 * - `run`: pass the argv on (the runner adds `-R OWNER/NAME` when the command needs one and the argv has none);
 * - `auth-status`: answered by the daemon from the account's record; `gh` is not run for it;
 * - `refuse`: a sentence.
 */

export type GhVerdict =
  | { readonly kind: 'run'; readonly argv: readonly string[]; readonly command: string; readonly repoCommand: boolean }
  | { readonly kind: 'auth-status'; readonly command: string }
  | { readonly kind: 'refuse'; readonly sentence: string; readonly command: string };

const TOKEN_SENTENCE =
  "Ferretry's gh never shows its token. It already acts as this project's connected GitHub account, so there is nothing to sign in to: run the command you wanted (for example `gh pr list`) directly.";
const CONFIG_SENTENCE =
  "Ferretry's gh has no config to read or change: it acts as this project's connected GitHub account. Nothing to configure.";
const PROGRAMS_SENTENCE =
  "Extensions, aliases and codespaces are not available in Ferretry's gh: each would run a program with the account's token in its environment.";
const GIT_SENTENCE =
  "Ferretry's gh does not run git or write files in your folder. Use git: pushes already go as this project's GitHub account over SSH (for a pull request: `git fetch origin pull/12/head:pr-12 && git switch pr-12`).";
const HOST_SENTENCE = "Ferretry's gh talks to github.com only: drop --hostname.";
const FILES_SENTENCE =
  "Ferretry's gh does not read local files: pass the text itself (--body, --notes, -f key=value) instead of --body-file, --notes-file, --input or -F.";
const TEMPLATE_SENTENCE =
  "--jq and --template can read the environment, so Ferretry's gh refuses them: use --json and filter the output yourself.";
const SHORT_T_SENTENCE =
  "-t means a different thing in different gh commands (title, template, token), so Ferretry's gh needs the long flag: --title, or --json for fields.";
const HEAD_SENTENCE =
  "Ferretry's gh runs in an empty folder and cannot see your branch: pass --head <branch> to `gh pr create` (push the branch first with `git push`).";
const FILL_SENTENCE =
  "--fill reads git history, which Ferretry's gh cannot see: give --title and --body (or --body-file's text with --body).";

/** Subcommands per command. `null` = the command takes no subcommand. */
const ALLOWED: ReadonlyMap<string, ReadonlySet<string> | null> = new Map<string, ReadonlySet<string> | null>([
  [
    'pr',
    new Set([
      'list',
      'view',
      'diff',
      'create',
      'edit',
      'comment',
      'review',
      'merge',
      'close',
      'reopen',
      'ready',
      'checks',
      'status',
      'update-branch',
      'lock',
      'unlock',
    ]),
  ],
  [
    'issue',
    new Set([
      'list',
      'view',
      'create',
      'comment',
      'edit',
      'close',
      'reopen',
      'delete',
      'lock',
      'unlock',
      'pin',
      'unpin',
      'status',
      'transfer',
      'develop',
    ]),
  ],
  ['run', new Set(['list', 'view', 'watch', 'rerun', 'cancel'])],
  ['workflow', new Set(['list', 'view', 'run', 'enable', 'disable'])],
  ['release', new Set(['list', 'view', 'create', 'edit', 'delete', 'upload', 'delete-asset'])],
  ['repo', new Set(['view', 'list', 'create', 'edit', 'fork'])],
  ['search', new Set(['repos', 'issues', 'prs', 'code', 'commits'])],
  ['label', new Set(['list', 'create', 'edit', 'delete'])],
  ['secret', new Set(['list', 'set', 'delete'])],
  ['variable', new Set(['list', 'get', 'set', 'delete'])],
  ['cache', new Set(['list', 'delete'])],
  ['ruleset', new Set(['list', 'view', 'check'])],
  ['gist', new Set(['list', 'view', 'create', 'edit', 'delete', 'rename'])],
  ['org', new Set(['list'])],
  ['project', new Set()],
  ['api', null],
  ['status', null],
  ['browse', null],
]);

/** Commands whose repository is the folder's, so the runner names it with `-R` (a flag every one of them has). */
const REPO_COMMANDS: ReadonlySet<string> = new Set([
  'pr',
  'issue',
  'run',
  'workflow',
  'release',
  'label',
  'secret',
  'variable',
  'cache',
  'ruleset',
]);

/** Each is "this runs git or writes into the folder, so it is not here", with the command that would. */
const GIT_FORMS: readonly (readonly string[])[] = [
  ['pr', 'checkout'],
  ['pr', 'co'],
  ['repo', 'clone'],
  ['repo', 'sync'],
  ['gist', 'clone'],
  ['run', 'download'],
  ['release', 'download'],
];
const GIT_FLAGS_BY_COMMAND: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['repo', new Set(['--clone', '--source', '--push', '-c'])],
  ['issue', new Set(['--checkout', '-c'])],
]);

const FILE_FLAGS: ReadonlySet<string> = new Set(['--body-file', '-F', '--field', '--notes-file', '--input']);
const TEMPLATE_FLAGS: ReadonlySet<string> = new Set(['--jq', '-q', '--template', '-T']);

/** `--long` or `-s`, without any `=value`. */
const flagName = (arg: string): string | undefined =>
  arg.startsWith('--') ? arg.split('=', 1)[0] : /^-[A-Za-z]$/u.test(arg) ? arg : undefined;

const isFlag = (arg: string): boolean => arg.startsWith('-');

/** The two words of a command for the audit and a sentence: only plain lowercase words, bounded; else `unknown`. */
const wordOf = (arg: string | undefined): string =>
  arg !== undefined && /^[a-z][a-z-]{0,23}$/u.test(arg) ? arg : 'unknown';
const commandOf = (argv: readonly string[]): string => {
  const first = wordOf(argv[0]);
  const second = argv[1] !== undefined && !isFlag(argv[1]) ? wordOf(argv[1]) : undefined;
  return second === undefined || first === 'api' ? first : `${first} ${second}`;
};

const shown = (text: string): string => `"${text.replace(/\p{Cc}/gu, '').slice(0, 40)}"`;

/** Whether the argv already names a repository (`-R x`, `--repo x`, `--repo=x`). */
export function namesRepository(argv: readonly string[]): boolean {
  return argv.some(arg => arg === '-R' || arg === '--repo' || arg.startsWith('--repo='));
}

/** Whether the argv names a head branch (`--head x`, `--head=x`, `-H x`). */
const namesHead = (argv: readonly string[]): boolean =>
  argv.some(arg => arg === '-H' || arg === '--head' || arg.startsWith('--head='));

/** A run that follows a workflow for minutes, so it gets the longer clock. */
export function isFollowing(argv: readonly string[]): boolean {
  return (
    (argv[0] === 'run' && argv[1] === 'watch') ||
    (argv[0] === 'pr' && argv[1] === 'checks' && argv.some(arg => arg === '--watch' || arg === '-w'))
  );
}

/** Where `-R OWNER/NAME` goes: right after the command and subcommand. */
export const withRepository = (argv: readonly string[], repo: string): readonly string[] => [
  ...argv.slice(0, 2),
  '-R',
  repo,
  ...argv.slice(2),
];

const VALUED_API_FLAGS: ReadonlySet<string> = new Set(['-X', '--method', '-H', '--header', '-f', '--raw-field']);

/** `gh api repos/{owner}/{repo}/...`: the placeholders gh would fill from a git folder, filled from the record. */
export function fillPlaceholders(argv: readonly string[], repo: string): readonly string[] {
  const [owner, name] = repo.split('/') as [string, string];
  let valueNext = false;
  let done = false;
  return argv.map((arg, at) => {
    if (at === 0) return arg;
    const wasValue = valueNext;
    valueNext = VALUED_API_FLAGS.has(arg);
    if (wasValue || isFlag(arg) || done) return arg;
    done = true;
    return arg.replaceAll('{owner}', owner).replaceAll('{repo}', name);
  });
}

const refuse = (sentence: string, argv: readonly string[]): GhVerdict => ({
  kind: 'refuse',
  sentence,
  command: commandOf(argv),
});

export function judgeGh(argv: readonly string[]): GhVerdict {
  const top = argv[0];
  if (top === undefined) return refuse("Give Ferretry's gh a command, for example `gh pr list`.", argv);

  // Any host other than github.com would be sent the token.
  if (argv.some(arg => arg === '--hostname' || arg.startsWith('--hostname='))) return refuse(HOST_SENTENCE, argv);

  if (top === 'auth') {
    if (argv[1] !== 'status') return refuse(TOKEN_SENTENCE, argv);
    const rest = argv.slice(2);
    if (rest.every(arg => arg === '--active' || arg === '-a')) return { kind: 'auth-status', command: 'auth status' };
    return refuse(TOKEN_SENTENCE, argv);
  }
  if (top === 'config') return refuse(CONFIG_SENTENCE, argv);
  if (
    top === 'extension' ||
    top === 'extensions' ||
    top === 'ext' ||
    top === 'alias' ||
    top === 'codespace' ||
    top === 'cs'
  )
    return refuse(PROGRAMS_SENTENCE, argv);

  if (!ALLOWED.has(top))
    return refuse(
      `${shown(top)} is not a command Ferretry's gh runs. Try pr, issue, run, workflow, release, repo, api or search.`,
      argv,
    );
  const subs = ALLOWED.get(top) as ReadonlySet<string> | null;
  const sub = argv[1];
  if (subs !== null) {
    if (sub === undefined || isFlag(sub)) return refuse(`\`gh ${top}\` needs a subcommand.`, argv);
    if (GIT_FORMS.some(([a, b]) => a === top && b === sub)) return refuse(GIT_SENTENCE, argv);
    // `project` has its own long list; anything shaped like a subcommand name goes on to the seam under this one.
    const known = top === 'project' ? /^[a-z][a-z-]{0,31}$/u.test(sub) : subs.has(sub);
    if (!known) return refuse(`${shown(`${top} ${sub}`)} is not run by Ferretry's gh.`, argv);
  }

  if (top === 'browse' && !argv.includes('--no-browser'))
    return refuse("Ferretry's gh cannot open a browser: use `gh browse --no-browser` to print the address.", argv);

  const flags = argv.slice(subs === null ? 1 : 2);
  const gitFlags = GIT_FLAGS_BY_COMMAND.get(top);
  const isIssueDevelop = top === 'issue' && sub === 'develop';
  for (const arg of flags) {
    const name = flagName(arg);
    if (name === undefined) continue;
    if (FILE_FLAGS.has(name)) return refuse(FILES_SENTENCE, argv);
    if (TEMPLATE_FLAGS.has(name)) return refuse(TEMPLATE_SENTENCE, argv);
    if (name === '-t' || name === '--show-token')
      return refuse(name === '-t' ? SHORT_T_SENTENCE : TOKEN_SENTENCE, argv);
    if (top === 'repo' && gitFlags?.has(name) === true) return refuse(GIT_SENTENCE, argv);
    if (isIssueDevelop && gitFlags?.has(name) === true) return refuse(GIT_SENTENCE, argv);
  }

  if (top === 'pr' && sub === 'create') {
    if (flags.some(arg => arg === '--fill' || arg === '-f' || arg === '--fill-first' || arg === '--fill-verbose'))
      return refuse(FILL_SENTENCE, argv);
    if (!namesHead(flags)) return refuse(HEAD_SENTENCE, argv);
  }

  return { kind: 'run', argv, command: commandOf(argv), repoCommand: REPO_COMMANDS.has(top) };
}
