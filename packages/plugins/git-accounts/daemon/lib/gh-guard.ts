/**
 * What a `gh` run as an account may be, and what its output may say.
 *
 * The token IS in the child's environment (that is the design: `use`, never `read`), so what is narrowed is what that
 * child can be asked to do. The seam is for **GitHub API work only**: pull requests, runs, issues, search, the API
 * itself. Anything that starts `git` or reads or writes a local file is OUT: ferrets clone and push with `git` and the
 * account's SSH key, never through `gh`.
 *
 * So the argv is checked against a strict ALLOW-list of SUBCOMMAND + FLAGS, never a deny-list: a command, subcommand or
 * flag nobody listed (`auth`, `extension`, `repo clone`, `pr checkout`, anything a later `gh` adds) is refused because it
 * is not named, not because someone remembered it. On top of that, `--`, any short-flag cluster (`-dF`), any flag that
 * takes a file or directory (`--body-file`, `-F`, `--notes-file`, `--template`, `-T`, `--input`) and any argument that
 * looks like a local path are refused wherever they appear.
 *
 * Residual, said plainly (docs/secrets.md "A Git account's token"): an allowed command still acts with the token's
 * scopes (`repo` among them) on the GitHub API. There is no `git` child on this seam.
 */
import { ApiError } from '@ferretry/kernel/contract';
import { GIT_ACCOUNT_CODES } from '../../contract/index.ts';

/** Subcommands per command. `api` has none (its own grammar below); `search` takes any one of its kinds. */
const GH_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'pr',
    new Set(['list', 'view', 'diff', 'checks', 'comment', 'review', 'create', 'edit', 'close', 'reopen', 'merge']),
  ],
  ['issue', new Set(['list', 'view', 'create', 'comment', 'edit', 'close', 'reopen'])],
  ['run', new Set(['list', 'view', 'watch', 'cancel', 'rerun'])],
  ['workflow', new Set(['list', 'view'])],
  ['repo', new Set(['view'])],
  ['release', new Set(['list', 'view'])],
]);
const SEARCH_KINDS: ReadonlySet<string> = new Set(['repos', 'issues', 'prs', 'code', 'commits']);

const MAX_ARGS = 64;
const MAX_ARG_BYTES = 16 * 1024;
/** Flags that read a local file or directory into a request, or aim the token at another host: refused everywhere. */
const REFUSED_FLAGS: ReadonlySet<string> = new Set([
  '--hostname',
  '--input',
  '--body-file',
  '-F',
  '--field',
  '--notes-file',
  '--template',
  '-T',
]);
/** `gh api`: the ONLY flags, each with whether it takes a value. Everything else is refused. */
const API_FLAGS: Readonly<Record<string, boolean>> = {
  '-X': true,
  '--method': true,
  '-H': true,
  '--header': true,
  '-f': true,
  '--raw-field': true,
  '--paginate': false,
  '--jq': true,
  '-q': true,
};
/** The flags whose VALUE may look like a path (a header, a field, a jq program are text, not a file). */
const TEXT_VALUED: ReadonlySet<string> = new Set(['-H', '--header', '-f', '--raw-field', '--jq', '-q']);
const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
/** An API endpoint: `graphql`, a REST path (`/repos/o/r`, `repos/o/r`), or an `api.github.com` address. */
const API_ENDPOINT =
  /^(?:https:\/\/api\.github\.com\/|\/)?[A-Za-z0-9._~!$&'()*+,;%/{}-]+(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?{}-]{0,1024})?$/u;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const GITHUB_URL = /^https:\/\/(?:github\.com|api\.github\.com)\//u;
/** `HOST/OWNER/REPO`: a repository named with a host. */
const HOSTED_REPO = /^([^/\s]+)\/[^/\s]+\/[^/\s]+$/u;
/** A flag standing alone: `-x` or `--long` / `--long=value`. */
const SHORT_FLAG = /^-[A-Za-z]$/u;
const LONG_FLAG = /^--[A-Za-z][A-Za-z0-9-]*(?:=|$)/u;

const refuse = (why: string): never => {
  throw new ApiError(403, `gh is not run that way: ${why}`, GIT_ACCOUNT_CODES.invalidRequest);
};

/** An argument that names a place on this machine. */
const looksLocal = (arg: string): boolean =>
  arg.startsWith('/') ||
  arg.startsWith('~') ||
  arg.startsWith('./') ||
  arg.startsWith('../') ||
  arg === '.' ||
  arg === '..' ||
  arg.includes('/..');

/** Flag syntax every command shares: no `--`, no cluster, no file-valued flag, no other host. */
function checkShape(arg: string): void {
  if (arg === '--') refuse('-- is not allowed');
  if (arg.startsWith('--')) {
    if (!LONG_FLAG.test(arg)) refuse('a malformed flag');
    const name = arg.split('=', 1)[0] as string;
    if (REFUSED_FLAGS.has(name)) refuse(`${name} is not allowed`);
  } else if (arg.startsWith('-')) {
    // Only a single letter, given on its own: `-dF` hides `-F`, `-iFquery=@file` hides a file read.
    if (!SHORT_FLAG.test(arg)) refuse('a short-flag cluster or a lone dash');
    if (REFUSED_FLAGS.has(arg)) refuse(`${arg} is not allowed`);
  }
}

function checkAddress(arg: string): void {
  if (SCHEME.test(arg) && !GITHUB_URL.test(arg)) refuse('an address outside github.com');
  const hosted = HOSTED_REPO.exec(arg);
  if (hosted !== null && (hosted[1] as string).toLowerCase() !== 'github.com' && /[.:]/u.test(hosted[1] as string))
    refuse('a repository on another host');
}

function checkApi(args: readonly string[]): void {
  let endpoint: string | undefined;
  for (let at = 1; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg.startsWith('@') || arg.includes('=@')) refuse('an argument that reads a file');
    checkShape(arg);
    if (arg.startsWith('-')) {
      const [name, inline] = arg.startsWith('--') ? (arg.split(/=(.*)/su, 2) as [string, string?]) : [arg, undefined];
      const takes = API_FLAGS[name];
      if (takes === undefined) refuse(`${name} is not a flag Ferretry runs gh api with`);
      if (takes === false) {
        if (inline !== undefined) refuse(`${name} takes no value`);
        continue;
      }
      if (inline === undefined) at += 1;
      const value = inline ?? args[at];
      if (value === undefined) refuse(`${name} needs a value`);
      const text = value as string;
      if (text.startsWith('@') || text.includes('=@')) refuse('an argument that reads a file');
      if (!TEXT_VALUED.has(name) && looksLocal(text)) refuse('a local path');
      if ((name === '-X' || name === '--method') && !METHODS.has(text)) refuse('an unknown method');
      if ((name === '-f' || name === '--raw-field') && !text.includes('=')) refuse('a field must be key=value');
      if ((name === '-H' || name === '--header') && /^host\s*:/iu.test(text)) refuse('the Host header is not set');
      continue;
    }
    if (endpoint !== undefined) refuse('more than one endpoint');
    endpoint = arg;
    // The one place a leading `/` is not a local path: the endpoint names an API path, and may only name one.
    if (!API_ENDPOINT.test(arg) || arg.includes('..') || arg.slice(8).includes('//') || arg.startsWith('//'))
      refuse('an endpoint that is not on api.github.com');
  }
  if (endpoint === undefined) refuse('gh api needs an endpoint');
}

function checkCommand(command: string, args: readonly string[]): void {
  const sub = args[1];
  const allowed = command === 'search' ? SEARCH_KINDS : GH_SUBCOMMANDS.get(command);
  if (sub === undefined || allowed === undefined || !allowed.has(sub))
    refuse(`"${command} ${(sub ?? '').slice(0, 40)}" is not run as an account`);
  for (let at = 2; at < args.length; at += 1) {
    const arg = args[at] as string;
    checkShape(arg);
    // A short flag has no value of its own; `--flag=value` carries one; anything else is a value or a positional.
    const value = arg.startsWith('--') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (SHORT_FLAG.test(arg) || (arg.startsWith('--') && !arg.includes('='))) continue;
    if (looksLocal(value)) refuse('a local path');
    checkAddress(value);
  }
}

/** Throws a 403 unless every part of `args` is something a run as an account may do. */
export function checkGhArgs(args: readonly string[]): void {
  if (args.length === 0 || args.length > MAX_ARGS) refuse('wrong number of arguments');
  for (const arg of args)
    if (arg.length > MAX_ARG_BYTES || arg.includes('\0')) refuse('an argument is too long or has a NUL');
  const command = args[0] as string;
  if (command === 'api') {
    checkApi(args);
    return;
  }
  if (command !== 'search' && !GH_SUBCOMMANDS.has(command))
    refuse(`"${command.slice(0, 40)}" is not a command Ferretry runs as an account`);
  checkCommand(command, args);
}

/** Every shape a GitHub token has, wherever it is printed: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and `github_pat_`. */
const TOKEN_SHAPE = /(?:gh[opsur]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})/gu;
const REDACTED = '[redacted]';

/** Output with the exact token and anything shaped like a GitHub token replaced. */
export function scrubToken(text: string, token: string): string {
  return text.split(token).join(REDACTED).replace(TOKEN_SHAPE, REDACTED);
}
