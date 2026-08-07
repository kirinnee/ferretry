/**
 * Telling the host manager to change a unit, and what a refusal means.
 *
 * ONE FUNCTION FOR BOTH CALLERS. The settings surface prepares the fleet slice when an operator
 * saves, and a launch prepares it again before it puts a scope underneath — so preparation happens
 * from two places and must mean exactly one thing. There is deliberately no memoised "already
 * prepared" flag: `set-property` is idempotent and cheap next to spawning an agent, while a cache
 * would go on believing a slice was configured after something outside this daemon had changed it.
 */

import type { CgroupCommandPort } from './ports.ts';

/** Why a resource-limit operation could not be completed. */
export type CgroupFailure =
  /** The request describes something the configuration cannot be. */
  | 'invalid'
  /** This host cannot enforce limits at all, and was asked to. */
  | 'unsupported'
  /** The host manager, or the document, refused work that was otherwise well-formed. */
  | 'failed';

/** A refusal raised by the cgroup domain, in a taxonomy the route table may restate. */
export class CgroupError extends Error {
  constructor(
    readonly failure: CgroupFailure,
    message: string,
  ) {
    super(message);
    this.name = 'CgroupError';
  }
}

/** The message a failed command should be reported by: the manager's own words when it produced
 *  any, and the caller's description when it produced none. */
export function commandFailureMessage(
  result: { readonly stdout: string; readonly stderr: string },
  fallback: string,
): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

/**
 * Run one host-manager command, raising the manager's own refusal.
 *
 * A non-zero exit is `failed` rather than `invalid`: the argv was composed by this daemon from an
 * already-validated configuration, so a refusal is a fact about the host — no user manager on this
 * session, an unknown property, a unit that vanished — and not about what the caller asked for.
 */
export async function runCgroupCommand(
  commands: CgroupCommandPort,
  argv: readonly string[],
  fallback: string,
): Promise<void> {
  const result = await commands.execute(argv);
  if (result.code !== 0) throw new CgroupError('failed', commandFailureMessage(result, fallback));
}

/** The message an unexpected throw should be reported by, so a report never contains `[object
 *  Object]` in place of the reason an operator needs. */
export function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
