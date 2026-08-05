/**
 * What the daemon does with its command line, decided BEFORE anything with a side effect runs.
 *
 * THE ORDERING IS THE SUBSTANCE HERE. This binary used to ignore its arguments completely, so
 * `fyd --version` did not print a version and did not reject the flag — it resolved a state home,
 * created the whole directory tree, took the lifetime lock, probed the address and attempted to
 * serve. Asking a program what it is provisioned a machine. A query must stay a query, so the answer
 * is a pure function of the arguments and the caller acts on it before it builds anything at all.
 *
 * IT IS AN OPERATOR SURFACE, NOT A TOOL. There are no session or fleet commands here; the client
 * owns those. What this binary owes a human is the ability to run it, ask what it is, ask what it
 * believes its configuration to be and where each value came from, and ask whether it would start —
 * the last two without touching anything.
 */

/** The levels a boot's own records are filtered by, from most to least. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** What one invocation says about this run, overriding the document for this run only. */
export interface RunOverrides {
  /** An explicit configuration document, instead of the one inside the state home. */
  readonly configFile?: string;
  readonly host?: string;
  readonly port?: number;
  readonly logLevel?: LogLevel;
}

/**
 * What this invocation asked for.
 *
 * `check` and `printConfiguration` are QUERIES in the same sense `--version` is — they read, they
 * report, and they create nothing. They are separate from `print` only because they need the world
 * to answer, so the caller must build one; nothing they do writes to it.
 */
export type ArgumentAnswer =
  | { readonly kind: 'boot'; readonly overrides: RunOverrides }
  | { readonly kind: 'check'; readonly overrides: RunOverrides }
  | { readonly kind: 'print-config'; readonly overrides: RunOverrides }
  | { readonly kind: 'print'; readonly text: string; readonly exitCode: number }
  | { readonly kind: 'refuse'; readonly text: string; readonly exitCode: number };

/** `EX_USAGE`: the command line itself was wrong, as distinct from anything the daemon then did. */
export const EXIT_USAGE = 64;

/** Everything the usage text has to name, so nothing in it is assembled from a global. */
export interface DaemonUsage {
  /** The daemon executable's own name. */
  readonly daemonName: string;
  /** The command a human actually drives, which is how this daemon is normally started. */
  readonly clientName: string;
  readonly version: string;
}

/**
 * What `--help` prints.
 *
 * THE EXIT CODES ARE DOCUMENTED HERE, because they are the daemon's contract with whatever supervises
 * it and there was previously nowhere at all to read them. They are also distinct now: 78 used to
 * mean both "another of me is already serving" and "something I could not identify holds the
 * address", which are opposite situations with opposite remedies.
 */
export function daemonUsageText(usage: DaemonUsage): string {
  return [
    `${usage.daemonName} ${usage.version} — the per-host agent daemon.`,
    '',
    `Run with no arguments to serve in the foreground, logging to standard error. Normally you do not:`,
    `\`${usage.clientName} daemon start\` installs or drives the service definition for this host and`,
    'starts it there.',
    '',
    'Usage:',
    `  ${usage.daemonName} [options]`,
    '',
    'Options:',
    '  -v, --version         print the version and exit, touching nothing',
    '  -h, --help            print this text and exit, touching nothing',
    '      --print-config    print the effective configuration and where each value came from,',
    '                        then exit without creating, locking or binding anything',
    '      --check           report whether this daemon would start — the state home, the agent',
    '                        harnesses it could launch, the address and who holds it — then exit',
    '                        without creating, locking or binding anything',
    '      --config <path>   read this configuration document instead of the one in the state home',
    '      --host <host>     serve on this host for one run, overriding the document',
    '      --port <port>     serve on this port for one run, overriding the document',
    '      --log-level <l>   one of debug, info, warn, error (default info). `debug` is accepted and',
    '                        currently selects the same records as `info`; this daemon emits none of',
    '                        its own below `info` yet.',
    '',
    'Environment:',
    '  FY_HOME               the state home to own; defaults to ~/.ferretry',
    `  PATH                  searched for the programs ${usage.daemonName} launches`,
    '',
    'Exit codes:',
    '  0                     served, then shut down cleanly',
    '  1                     failed for a reason that is neither of the two below',
    '  64                    the command line was wrong',
    `  69                    the address is held by something that is not a ${usage.daemonName}`,
    `  78                    another ${usage.daemonName} already owns this address or state home`,
    '',
    'Everything else — the address, the credentials, the operator settings — lives in',
    `<FY_HOME>/config/daemon.json. Run \`${usage.daemonName} --print-config\` to see what is in effect.`,
  ].join('\n');
}

/** A flag that takes a value, and how its value is read. */
const VALUE_FLAGS = {
  '--config': (value: string, overrides: RunOverrides): RunOverrides | string => ({ ...overrides, configFile: value }),
  '--host': (value: string, overrides: RunOverrides): RunOverrides | string =>
    value.trim() === '' ? 'a host must not be empty' : { ...overrides, host: value.trim() },
  '--port': (value: string, overrides: RunOverrides): RunOverrides | string => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return `${JSON.stringify(value)} is not a port number`;
    return { ...overrides, port };
  },
  '--log-level': (value: string, overrides: RunOverrides): RunOverrides | string =>
    (LOG_LEVELS as readonly string[]).includes(value)
      ? { ...overrides, logLevel: value as LogLevel }
      : `${JSON.stringify(value)} is not a log level; expected one of ${LOG_LEVELS.join(', ')}`,
} as const;

/** The modes that read and report rather than serve. */
const QUERY_MODES = { '--print-config': 'print-config', '--check': 'check' } as const;

/**
 * The answer for one command line.
 *
 * NO ARGUMENTS MEANS BOOT, which is the only invocation a service manager ever makes.
 *
 * `--version` AND `--help` ANSWER ALONE. Combined with anything else they are refused rather than
 * honoured, because guessing which half of `--version --port 80` to obey is the ignoring defect
 * again, and an ignored flag is how somebody ends up believing they configured something.
 *
 * AN UNRECOGNISED ARGUMENT IS REFUSED with a non-zero code and the usage text. The alternative is a
 * daemon that boots while a person believes they asked for something else entirely.
 */
export function answerArguments(argv: readonly string[], usage: DaemonUsage): ArgumentAnswer {
  if (argv.length === 0) return { kind: 'boot', overrides: {} };
  const [first] = argv;
  if (first === '--version' || first === '-v')
    return argv.length === 1
      ? { kind: 'print', text: usage.version, exitCode: 0 }
      : refusal(usage, `${first} answers on its own; it cannot be combined with ${argv.slice(1).join(' ')}`);
  if (first === '--help' || first === '-h')
    return argv.length === 1
      ? { kind: 'print', text: daemonUsageText(usage), exitCode: 0 }
      : refusal(usage, `${first} answers on its own; it cannot be combined with ${argv.slice(1).join(' ')}`);

  let mode: ArgumentAnswer['kind'] = 'boot';
  let overrides: RunOverrides = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const query = QUERY_MODES[argument as keyof typeof QUERY_MODES];
    if (query !== undefined) {
      if (mode !== 'boot' && mode !== query)
        return refusal(usage, `--print-config and --check ask different questions`);
      mode = query;
      continue;
    }
    const flag = VALUE_FLAGS[argument as keyof typeof VALUE_FLAGS];
    if (flag === undefined) return refusal(usage, `${JSON.stringify(argument)} is not an option this daemon has`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) return refusal(usage, `${argument} needs a value`);
    const applied = flag(value, overrides);
    if (typeof applied === 'string') return refusal(usage, applied);
    overrides = applied;
    index += 1;
  }
  return mode === 'boot' ? { kind: 'boot', overrides } : { kind: mode, overrides };
}

function refusal(usage: DaemonUsage, reason: string): ArgumentAnswer {
  return {
    kind: 'refuse',
    // The usage text comes WITH the refusal rather than being referred to, because a person who just
    // got an option wrong is exactly the person who needs to see the options.
    text: `${usage.daemonName}: ${reason}.\n\n${daemonUsageText(usage)}`,
    exitCode: EXIT_USAGE,
  };
}
