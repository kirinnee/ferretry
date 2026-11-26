/** Formatting is data for a different, tokenless child; it must never reach credential-bearing gh. */
import { ApiError } from '@ferretry/kernel/contract';
import { GIT_ACCOUNT_CODES } from '../../contract/index.ts';

const refuse = (message: string): never => {
  throw new ApiError(403, message, GIT_ACCOUNT_CODES.invalidRequest);
};

export function splitGhFormat(args: readonly string[]): { argv: readonly string[]; filter?: string } {
  if (args.length === 0 || args.length > 64 || args.some(arg => arg.length > 16 * 1024 || arg.includes('\0')))
    refuse('gh is not run that way: wrong number of arguments, or an argument is too long or has a NUL');
  const argv: string[] = [];
  let filter: string | undefined;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg === '--template' || arg.startsWith('--template=') || arg === '-T')
      refuse('Ferretry has no safe stdin template formatter: use --jq instead.');
    if (arg === '--jq' || arg === '-q' || arg.startsWith('--jq=') || arg.startsWith('-q')) {
      if (filter !== undefined) refuse('Give gh only one --jq filter.');
      const value =
        (arg.startsWith('--jq=') ? arg.slice(5) : arg.startsWith('-q') && arg.length > 2 ? arg.slice(2) : args[++at]) ??
        refuse('--jq needs a filter.');
      if (/\b(?:import|include|modulemeta)\b/u.test(value)) refuse("module loading isn't allowed in --jq");
      filter = value;
    } else argv.push(arg);
  }
  if (filter !== undefined && argv[0] !== 'api' && !argv.some(arg => arg === '--json' || arg.startsWith('--json=')))
    refuse('--jq needs --json fields on this gh command.');
  return { argv, ...(filter === undefined ? {} : { filter }) };
}

/** Rebuild help from plain topic words only: flags, values and extension invocations never run. */
export function ghHelpArgs(args: readonly string[]): readonly string[] | undefined {
  if (args.length === 1 && args[0] === '--version') return args;
  if (args[0] !== 'help' && !args.includes('--help')) return undefined;
  const words: string[] = [];
  for (const arg of args[0] === 'help' ? args.slice(1) : args) {
    if (arg === '--help') continue;
    if (!/^[a-z][a-z-]{0,31}$/u.test(arg)) break;
    words.push(arg);
  }
  return ['help', ...words];
}
