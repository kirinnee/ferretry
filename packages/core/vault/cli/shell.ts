/**
 * STAND-INS for what Vault's CLI half needs and the 5.0 CLI context does not offer yet, each a short copy of the code
 * Accounts' and Access's CLI ports keep in their own `cli/shell.ts` (a plugin may not import another's):
 *
 * 1. Commander's reading of a verb's words (`readInvocation`): the manifest declares a verb's words only, so an unknown
 *    option, a missing argument or an extra one is refused here with commander's own sentences and exit 1. This is what
 *    makes `fy secret set` take NO value argument: a second word is "too many arguments", and `--value` is "unknown
 *    option", before anything runs. A verb that takes options (`secret use --with`) NAMES each one in its shape; every
 *    other spelling is refused the same way.
 * 2. `ExitStatus` and `verbHandler`: an error a controller throws is printed as commander's action errors were.
 *
 * Nothing here prints an argument back. A refusal names the option and the verb, never the word a person typed after
 * it, so a value pasted onto the command line by mistake does not reach the terminal's scrollback twice.
 */
import type { TerminalIo, VerbHandler, VerbInvocation } from '@ferretry/kernel/manifest';

/** One option a verb takes: every spelling (`with`, `w`) and whether a value follows it. */
export interface OptionShape {
  readonly names: readonly string[];
  readonly takesValue: boolean;
}

/** What one verb accepts: the required positionals, the options it names, and whether the last positional repeats. */
export interface VerbShape {
  readonly command: string;
  readonly args: readonly string[];
  /** The options this verb takes. Every other option is refused. Default: none. */
  readonly options?: readonly OptionShape[];
  /** The last positional takes one or more words (`<command...>`); more than `args.length` words are then fine. */
  readonly variadic?: boolean;
}

const spelled = (given: string, value: unknown): string =>
  value === false ? `--no-${given}` : `${given.length === 1 ? '-' : '--'}${given}`;

/** The verb's words, or commander's refusal sentence for them. Pure. */
function readInvocation(invocation: VerbInvocation, shape: VerbShape): { readonly refused: string } | undefined {
  const known = (shape.options ?? []).flatMap(option => option.names);
  for (const [given, value] of Object.entries(invocation.options)) {
    if (!known.includes(given)) return { refused: `error: unknown option '${spelled(given, value)}'` };
    const option = (shape.options ?? []).find(each => each.names.includes(given));
    if (option?.takesValue === true && (typeof value === 'boolean' || (Array.isArray(value) && value.length === 0)))
      return { refused: `error: option '${spelled(given, value)}' argument missing` };
  }
  const missing = shape.args[invocation.args.length];
  if (missing !== undefined) return { refused: `error: missing required argument '${missing}'` };
  const most = shape.args.length;
  if (shape.variadic !== true && invocation.args.length > most)
    return {
      refused: `error: too many arguments for '${shape.command}'. Expected ${String(most)} argument${most === 1 ? '' : 's'} but got ${String(invocation.args.length)}.`,
    };
  return undefined;
}

/** The exit status a controller sets; a verb answers it. */
export class ExitStatus {
  #code = 0;
  setExitCode(code: number): void {
    this.#code = code;
  }
  get code(): number {
    return this.#code;
  }
}

const isShellError = (error: unknown): boolean =>
  error instanceof Error && typeof (error as Error & { exitCode?: unknown }).exitCode === 'number';

/** A verb handler: read the words (refusing as commander did), run, and print a thrown error as commander did. */
export function verbHandler(
  io: Pick<TerminalIo, 'err'>,
  exit: ExitStatus,
  shape: VerbShape,
  run: (invocation: VerbInvocation) => Promise<void>,
): VerbHandler {
  return async invocation => {
    const refused = readInvocation(invocation, shape);
    if (refused !== undefined) {
      io.err(`${refused.refused}\n`);
      return 1;
    }
    try {
      await run(invocation);
    } catch (error) {
      if (isShellError(error)) throw error;
      io.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    return exit.code;
  };
}
