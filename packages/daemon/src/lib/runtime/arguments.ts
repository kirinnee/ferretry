/**
 * What the daemon does with its command line, decided BEFORE anything with a side effect runs.
 *
 * THE ORDERING IS THE SUBSTANCE HERE. This binary used to ignore its arguments completely, so
 * `fyd --version` did not print a version and did not reject the flag — it resolved a state home,
 * created the whole directory tree, took the lifetime lock, probed the address and attempted to
 * serve. Asking a program what it is provisioned a machine. A query must stay a query, so the answer
 * is a pure function of the arguments and the caller acts on it before it builds anything at all.
 *
 * THREE BEHAVIOURS AND NO MORE. A daemon is not a tool; it is a thing a launcher starts. What it
 * owes a human at the command line is its version, an explanation of what it is, and a refusal of
 * anything it does not understand — never a silent one, because an ignored flag is how somebody ends
 * up believing they configured something.
 */
export type ArgumentAnswer =
  | { readonly kind: 'boot' }
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

/** What `--help` prints: what this is, who starts it, and the environment it reads. */
export function daemonUsageText(usage: DaemonUsage): string {
  return [
    `${usage.daemonName} ${usage.version} — the per-host agent daemon.`,
    '',
    `It is a long-running server, not a tool. Start it with \`${usage.clientName} daemon start\`, which`,
    `installs or drives the service definition for this host; running ${usage.daemonName} directly serves`,
    'in the foreground until interrupted.',
    '',
    'Options:',
    '  -v, --version   print the version and exit, touching nothing',
    '  -h, --help      print this text and exit, touching nothing',
    '',
    'Environment:',
    '  FY_HOME         the state home to own; defaults to ~/.ferretry',
    `  PATH            searched for the programs ${usage.daemonName} launches`,
    '',
    'Everything else — the address, the credentials, the operator settings — lives in',
    '<FY_HOME>/config/daemon.json, which is created on first start.',
  ].join('\n');
}

/**
 * The answer for one command line.
 *
 * NO ARGUMENTS MEANS BOOT, which is the only invocation a service manager ever makes. Anything else
 * is a human at a terminal, and the two flags they might reasonably try are answered exactly.
 *
 * AN UNRECOGNISED ARGUMENT IS REFUSED rather than ignored, and refused with a non-zero code, because
 * the alternative is a daemon that boots while a person believes they asked for something else.
 * Combining a query with anything else is refused for the same reason: `--version --serve` is not a
 * request this understands, and guessing which half to honour would be the ignoring defect again.
 */
export function answerArguments(argv: readonly string[], usage: DaemonUsage): ArgumentAnswer {
  if (argv.length === 0) return { kind: 'boot' };
  const [first] = argv;
  if (argv.length === 1 && (first === '--version' || first === '-v'))
    return { kind: 'print', text: usage.version, exitCode: 0 };
  if (argv.length === 1 && (first === '--help' || first === '-h'))
    return { kind: 'print', text: daemonUsageText(usage), exitCode: 0 };
  return {
    kind: 'refuse',
    text: `${usage.daemonName}: ${JSON.stringify(argv.join(' '))} is not something ${usage.daemonName} understands. Run \`${usage.daemonName} --help\`, or start the daemon with \`${usage.clientName} daemon start\`.`,
    exitCode: EXIT_USAGE,
  };
}
