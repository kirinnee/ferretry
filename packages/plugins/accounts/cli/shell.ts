/**
 * STAND-INS for what Accounts' CLI half needs and the 5.0 CLI context does not offer yet, each a short copy of today's
 * code (the same three Access's CLI port keeps in its own `cli/shell.ts`; a plugin may not import another's):
 *
 * 1. `FyHttpError` / `FyTransportError` and `callDaemon`: today's `@ferretry/protocol/client` errors, which the
 *    controllers read refusals by. `PluginClient.call` throws the shell's `DaemonRefusal` (`status`, `code`) for an
 *    HTTP refusal; it is recognised by shape. REPLACE WITH: a kernel-exported refusal on `@ferretry/kernel/manifest`.
 * 2. Commander's reading of a verb's words (`readInvocation`): the manifest declares a verb's words only, so unknown
 *    options, missing values, missing or extra arguments are refused here with commander's sentences and exit 1.
 * 3. `ExitStatus` and `verbHandler`: an error a controller throws is printed as commander's action errors were.
 */
import type { PluginClient, TerminalIo, VerbHandler, VerbInvocation } from '@ferretry/kernel/manifest';

// ─── 1. the client's errors ───────────────────────────────────────────────────────────────────────────────────────

/** The daemon did not answer at all. Copied from today's `fy-api-client.ts`. */
export class FyTransportError extends Error {
  override readonly name = 'FyTransportError';
  constructor(
    message: string,
    readonly path: string,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

/** The daemon answered with a refusal. Copied from today's `fy-api-client.ts`. */
export class FyHttpError extends Error {
  override readonly name = 'FyHttpError';
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

function refusalOf(
  error: unknown,
): { readonly message: string; readonly status: number; readonly code?: string } | undefined {
  if (!(error instanceof Error) || error.name !== 'DaemonRefusal') return undefined;
  const { status, code } = error as Error & { status?: unknown; code?: unknown };
  if (typeof status !== 'number') return undefined;
  return typeof code === 'string' ? { message: error.message, status, code } : { message: error.message, status };
}

const isShellError = (error: unknown): boolean =>
  error instanceof Error && typeof (error as Error & { exitCode?: unknown }).exitCode === 'number';

export interface DaemonCallInit {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** The only client capability the gateways consume. */
export type DaemonCaller = Pick<PluginClient, 'call'>;

/** One daemon call: a refusal is a `FyHttpError`, a daemon that did not answer a `FyTransportError`. */
export async function callDaemon(client: DaemonCaller, route: string, init?: DaemonCallInit): Promise<unknown> {
  try {
    return await client.call<unknown>(route, init);
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal !== undefined) throw new FyHttpError(refusal.message, refusal.status, refusal.code);
    if (isShellError(error)) throw error;
    throw new FyTransportError(error instanceof Error ? error.message : 'the daemon did not answer', route, error);
  }
}

// ─── 2. reading a verb's words, as commander did ──────────────────────────────────────────────────────────────────

/**
 * What one verb accepts. `switches`: flags with no value (`no-x` for a negation commander accepted); `values`: flags
 * that take one value; `repeatable`: flags that take one value and may be given again; `aliases`: short → long.
 * `args` are the required positionals, `optional` the one optional positional after them.
 */
export interface VerbShape {
  readonly command: string;
  readonly args: readonly string[];
  readonly optional?: string;
  readonly switches?: readonly string[];
  readonly values?: readonly string[];
  readonly repeatable?: readonly string[];
  readonly required?: readonly string[];
  readonly aliases?: Readonly<Record<string, string>>;
}

export interface ReadVerb {
  readonly args: readonly string[];
  /** Commander's option object: camelCase keys, `true`/`false` for switches, strings, string arrays. */
  readonly options: Readonly<Record<string, string | boolean | readonly string[]>>;
}

const camel = (flag: string): string => flag.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

/** The verb's words, or commander's refusal sentence for them. Pure. */
export function readInvocation(invocation: VerbInvocation, shape: VerbShape): ReadVerb | { readonly refused: string } {
  const options: Record<string, string | boolean | readonly string[]> = {};
  for (const [given, value] of Object.entries(invocation.options)) {
    const name = shape.aliases?.[given] ?? given;
    const typed = value === false ? `--no-${given}` : `${given.length === 1 ? '-' : '--'}${given}`;
    const takesValue = shape.values?.includes(name) === true || shape.repeatable?.includes(name) === true;
    if (typeof value === 'boolean') {
      if (takesValue && value) return { refused: `error: option '${typed}' argument missing` };
      if (!(shape.switches ?? []).includes(value ? name : `no-${name}`))
        return { refused: `error: unknown option '${typed}'` };
      options[camel(name)] = value;
      continue;
    }
    if (!takesValue)
      return (shape.switches ?? []).includes(name)
        ? { refused: `error: option '${typed}' takes no value` }
        : { refused: `error: unknown option '${typed}'` };
    const values = typeof value === 'string' ? [value] : value;
    if (shape.repeatable?.includes(name) === true) options[camel(name)] = values;
    else {
      const last = values[values.length - 1];
      if (last === undefined) return { refused: `error: option '${typed}' argument missing` };
      options[camel(name)] = last;
    }
  }
  for (const name of shape.required ?? [])
    if (options[camel(name)] === undefined) return { refused: `error: required option '--${name}' not specified` };
  const missing = shape.args[invocation.args.length];
  if (missing !== undefined) return { refused: `error: missing required argument '${missing}'` };
  const most = shape.args.length + (shape.optional === undefined ? 0 : 1);
  if (invocation.args.length > most)
    return {
      refused: `error: too many arguments for '${shape.command}'. Expected ${String(most)} argument${most === 1 ? '' : 's'} but got ${String(invocation.args.length)}.`,
    };
  return { args: invocation.args, options };
}

// ─── 3. running a verb ────────────────────────────────────────────────────────────────────────────────────────────

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

/** A verb handler: read the words (refusing as commander did), run, and print a thrown error as commander did. */
export function verbHandler(
  io: Pick<TerminalIo, 'err'>,
  exit: ExitStatus,
  shape: VerbShape,
  run: (read: ReadVerb) => Promise<void>,
): VerbHandler {
  return async invocation => {
    const read = readInvocation(invocation, shape);
    if ('refused' in read) {
      io.err(`${read.refused}\n`);
      return 1;
    }
    try {
      await run(read);
    } catch (error) {
      if (isShellError(error)) throw error;
      io.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    return exit.code;
  };
}
