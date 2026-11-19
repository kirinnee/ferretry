/**
 * What a `gh` run as an account may be, and what its output may say.
 *
 * The token IS in the child's environment (that is the design: `use`, never `read`), so what is narrowed is what that
 * child can be asked to do. The argv is checked against an ALLOW-list of top-level commands, never a deny-list: a
 * command nobody listed (`auth`, `extension`, `alias`, `config`, `codespace`, anything a later `gh` adds) is refused
 * because it is not named, not because someone remembered it. A few flags that move the token to another host, or read
 * a local file into a request, are refused wherever they appear.
 *
 * Residual, said plainly (docs/secrets.md "A Git account's token"): `gh` runs `git` for `repo clone`, `pr checkout` and
 * the like, and that `git` child inherits the token; a repository's own hooks or config can read it.
 */
import { ApiError } from '@ferretry/kernel/contract';
import { GIT_ACCOUNT_CODES } from '../../contract/index.ts';

/** The top-level commands the units that run `gh` need. `auth`, `config`, `alias`, `extension`/`ext` are NOT here. */
const GH_COMMANDS: ReadonlySet<string> = new Set([
  'api',
  'pr',
  'run',
  'repo',
  'issue',
  'workflow',
  'release',
  'search',
]);

const MAX_ARGS = 64;
const MAX_ARG_BYTES = 16 * 1024;
/** Flags that read a local file into a request, or aim the token at another host. Refused wherever they appear. */
const REFUSED_FLAGS = new Set(['--hostname', '--input', '--body-file', '--notes-file']);
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const GITHUB_URL = /^https:\/\/(?:github\.com|api\.github\.com)\//u;
/** `HOST/OWNER/REPO`: a repository named with a host. */
const HOSTED_REPO = /^([^/\s]+)\/[^/\s]+\/[^/\s]+$/u;

const refuse = (why: string): never => {
  throw new ApiError(403, `gh is not run that way: ${why}`, GIT_ACCOUNT_CODES.invalidRequest);
};

/** Throws a 403 unless every part of `args` is something a run as an account may do. */
export function checkGhArgs(args: readonly string[]): void {
  if (args.length === 0 || args.length > MAX_ARGS) refuse('wrong number of arguments');
  for (const arg of args)
    if (arg.length > MAX_ARG_BYTES || arg.includes('\0')) refuse('an argument is too long or has a NUL');
  const command = args[0] as string;
  if (!GH_COMMANDS.has(command)) refuse(`"${command.slice(0, 40)}" is not a command Ferretry runs as an account`);
  for (let at = 1; at < args.length; at += 1) {
    const arg = args[at] as string;
    const flag = arg.startsWith('--') ? (arg.split('=', 1)[0] as string) : arg;
    if (REFUSED_FLAGS.has(flag)) refuse(`${flag} is not allowed`);
    if (SCHEME.test(arg) && !GITHUB_URL.test(arg)) refuse('an address outside github.com');
    const hosted = HOSTED_REPO.exec(arg);
    if (hosted !== null && (hosted[1] as string).toLowerCase() !== 'github.com' && /[.:]/u.test(hosted[1] as string))
      refuse('a repository on another host');
    const typed = arg === '-F' || arg === '--field' ? args[at + 1] : undefined;
    const fused = arg.startsWith('--field=')
      ? arg.slice('--field='.length)
      : /^-F.+/u.test(arg)
        ? arg.slice(2)
        : undefined;
    const field = typed ?? fused;
    if (field !== undefined) {
      // `gh api -F key=@file` reads a host file into the request; on every other command `-F` is a body FILE.
      if (command !== 'api') refuse('-F reads a file');
      if ((field.split('=').slice(1).join('=') || '').startsWith('@')) refuse('a field that reads a file');
    }
  }
}

/** Every shape a GitHub token has, wherever it is printed: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and `github_pat_`. */
const TOKEN_SHAPE = /(?:gh[opsur]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})/gu;
const REDACTED = '[redacted]';

/** Output with the exact token and anything shaped like a GitHub token replaced. */
export function scrubToken(text: string, token: string): string {
  return text.split(token).join(REDACTED).replace(TOKEN_SHAPE, REDACTED);
}
