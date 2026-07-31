/**
 * The fallback usage probe: which command the daemon runs when the collector endpoint is not
 * listening, and the flags it must always be run with.
 *
 * The operator names the tool — the source spelled one tool's name into the daemon, so the fallback
 * could not be changed without editing the daemon — but the daemon owns the *data contract* it asks
 * for, because getting that wrong is silent and expensive.
 */

/**
 * Flags the daemon appends to whatever usage command it is pointed at.
 *
 * `--all` is BILLING-CRITICAL. A fleet collector asked for usage without it hides
 * `usageBased: false` accounts — the ones metered per API call rather than by subscription — because
 * they have no quota percentage worth showing a human. The daemon needs those explicit rows: without
 * them an API-billed account is indistinguishable from an account that does not exist, and the cost
 * surface silently under-reports every token it bills for.
 *
 * `--json` is the wire format {@link parseUsageAccounts} expects, and `--no-relogin` keeps the probe
 * non-interactive: a daemon has no terminal for an authentication prompt to appear on, so a probe
 * that decides to re-login hangs until its timeout instead of reporting.
 */
export const USAGE_PROBE_FLAGS: readonly string[] = ['--json', '--all', '--no-relogin'];

/**
 * The argv for the fallback probe, or `undefined` when no command is configured and the daemon
 * therefore has no fallback. A flag the operator already supplied is not repeated.
 */
export function usageProbeCommand(configured: readonly string[]): readonly [string, ...string[]] | undefined {
  const parts = configured.map(part => part.trim()).filter(part => part.length > 0);
  const [executable, ...rest] = parts;
  if (executable === undefined) return undefined;
  return [executable, ...rest, ...USAGE_PROBE_FLAGS.filter(flag => !rest.includes(flag))];
}
