import { type CoreAccount, type HarnessKind, HarnessKindSchema } from './inventory.ts';

/**
 * Turning a published wrapper name into something this host can execute.
 *
 * A PORT rather than a path lookup at the point of use, because it is the one step in a start that
 * depends on the machine the daemon happens to be running on: a test proves the refusal a fleet
 * naming an uninstalled wrapper deserves without needing that wrapper installed to do it.
 *
 * It lives HERE, beside the launchability rule, rather than in the composition root where it began.
 * The rule and the lookup are one answer to one question — "could a start actually run this?" — and
 * a second declaration of either is a second notion of what "installed" means.
 */
export interface ExecutableResolverPort {
  /** The absolute executable, or `undefined` when this host has no such program. */
  resolve(name: string): string | undefined;
}

/**
 * Whether a start could actually run this account, and if not, which half failed.
 *
 * THE ONE RULE, read by both callers. A start resolves an account by exactly these two conditions —
 * the manifest declares it available, and this host can run the wrapper it names — and the preflight
 * reports on them. Written twice they would drift, and the drift would be the worst possible kind:
 * a preflight that says a harness is ready and a start that then refuses it, or the reverse.
 *
 * WHAT IT DOES NOT ESTABLISH, and this matters more than what it does. A wrapper on `PATH` is not a
 * wrapper that is signed in, in credit, or able to reach its provider. Nothing here launches
 * anything, so nothing here can promise a session will start — only that this daemon would get as
 * far as trying. Every message built from it says so, because claiming the stronger thing from the
 * weaker evidence is exactly the overclaiming this product has been bitten by.
 */
export type AccountLaunchability =
  | { readonly kind: 'launchable'; readonly executable: string }
  | { readonly kind: 'declared-unavailable'; readonly reason: string }
  | { readonly kind: 'absent-executable'; readonly reason: string };

export function accountLaunchability(account: CoreAccount, executables: ExecutableResolverPort): AccountLaunchability {
  if (!account.available)
    return {
      kind: 'declared-unavailable',
      reason: `account ${account.agent} cannot serve a session: ${account.unavailableReason ?? 'the manifest reports it unavailable'}`,
    };
  // The manifest publishes an executable NAME; the lifecycle demands an absolute path, because the
  // wrapper authorization is what stops this daemon launching anything else. Resolving it against
  // this host's PATH is the only step that can tell a fleet the daemon cannot actually run.
  const executable = executables.resolve(account.agent);
  if (executable === undefined)
    return {
      kind: 'absent-executable',
      reason: `the fleet publishes ${account.agent} but this host has no such executable on its PATH`,
    };
  return { kind: 'launchable', executable };
}

/** One harness, as a boot can see it without launching anything. */
export interface HarnessReadiness {
  readonly kind: HarnessKind;
  /** Wrapper names a start could resolve right now. */
  readonly launchable: readonly string[];
  /** Every published account this harness has that a start could NOT resolve, and why. */
  readonly blocked: readonly string[];
  /**
   * Whether the harness's own command is on this host's `PATH` — a WEAKER and different fact.
   *
   * It is reported because of the one genuinely confusing case: somebody installs Claude Code, is
   * told no harness is ready, and is right to object. This daemon does not launch `claude`; it
   * launches the wrappers the fleet manifest publishes, so an installed harness with no declared
   * account is invisible to a start no matter how present it is. Saying "installed, but no account
   * is published for it" turns a report that looks wrong into one that names the missing step.
   *
   * The name comes from {@link HarnessKind} itself rather than a second table, so there is nothing
   * here that can disagree with the kind an account declares.
   */
  readonly commandOnPath: boolean;
}

/**
 * What this host could launch, per harness.
 *
 * EVERY HARNESS IS REPORTED, including one with nothing published at all. A report that listed only
 * what it found could not answer "is Codex set up?", which is the question being asked.
 */
export interface HarnessPreflight {
  readonly harnesses: readonly HarnessReadiness[];
  /** The bar: at least one account, of any harness, a start could resolve. */
  readonly ready: boolean;
}

export function readHarnessPreflight(
  accounts: readonly CoreAccount[],
  executables: ExecutableResolverPort,
): HarnessPreflight {
  const harnesses = HarnessKindSchema.options.map((kind): HarnessReadiness => {
    const launchable: string[] = [];
    const blocked: string[] = [];
    for (const account of accounts.filter(row => row.kind === kind)) {
      const launchability = accountLaunchability(account, executables);
      if (launchability.kind === 'launchable') launchable.push(account.agent);
      else blocked.push(launchability.reason);
    }
    return { kind, launchable, blocked, commandOnPath: executables.resolve(kind) !== undefined };
  });
  return { harnesses, ready: harnesses.some(harness => harness.launchable.length > 0) };
}

/** The one-line detail a boot milestone carries: what was found, per harness, in a glance. */
export function harnessPreflightSummary(preflight: HarnessPreflight): string {
  return preflight.harnesses
    .map(harness =>
      harness.launchable.length === 0
        ? `${harness.kind}: none${harness.blocked.length === 0 ? '' : ` (${String(harness.blocked.length)} published but unusable)`}`
        : `${harness.kind}: ${harness.launchable.join(', ')}`,
    )
    .join('; ');
}

/**
 * What a boot says when this host can launch no agent at all.
 *
 * A WARNING, NEVER A REFUSAL. Someone may install a harness minutes after the daemon comes up, and a
 * daemon that would not start until they had is strictly worse than one that starts and says what is
 * missing. But it is said LOUDLY and at startup rather than left for a person to discover as a
 * confusing failure the first time they try to launch an agent — a daemon that is healthy by every
 * internal measure and useless to the person in front of it is the failure this whole class of check
 * exists to stop shipping.
 *
 * IT NAMES A REMEDY, because a diagnosis on its own leaves the reader exactly where they were.
 */
export function harnessAbsentWarning(preflight: HarnessPreflight, clientName: string): string {
  const blocked = preflight.harnesses.flatMap(harness => harness.blocked);
  const installed = preflight.harnesses.filter(harness => harness.commandOnPath).map(harness => harness.kind);
  const cause =
    blocked.length === 0
      ? // The confusing case gets its own sentence: a person who just installed the harness is told
        // what is actually missing rather than a claim they can see is wrong.
        installed.length === 0
        ? 'the fleet manifest publishes no agent account at all'
        : `${installed.join(' and ')} ${installed.length === 1 ? 'is' : 'are'} on this host's PATH, but the fleet manifest publishes no account for ${installed.length === 1 ? 'it' : 'either'} — this daemon launches the wrappers the manifest declares, never the harness command directly`
      : `every published account is unusable — ${blocked.join('; ')}`;
  return `no agent harness is ready on this host, so this daemon can serve its API but cannot start a session: ${cause}. Install Claude Code or Codex, declare an account for it, and run \`${clientName} fleet apply\` to publish the manifest this daemon reads — \`${clientName} fleet ls\` shows what is published now. The daemon does not need restarting for that — it re-reads the manifest on every session start — but this line is what it saw at boot.`;
}

/**
 * The `--check` block: what was found, where it is short, and what none of it proves.
 *
 * The LIMIT IS PRINTED EVERY TIME, not only when something is wrong. A reader who sees "claude:
 * ready" and takes it to mean "signed in and working" has been misled by a report that was accurate,
 * which is a worse outcome than one that was obviously incomplete.
 */
export function renderHarnessPreflight(preflight: HarnessPreflight, clientName: string): readonly string[] {
  const lines = preflight.harnesses.map(harness => {
    const state =
      harness.launchable.length > 0
        ? `ready — ${harness.launchable.join(', ')}`
        : harness.blocked.length > 0
          ? `not usable — ${harness.blocked.join('; ')}`
          : harness.commandOnPath
            ? // Named apart from the plain absence, because it is a different missing step: the
              // harness is here, the account that would let this daemon launch it is not.
              `no account published (the ${harness.kind} command is on PATH, but this daemon launches published wrappers)`
            : 'no account published, and the command is not on PATH';
    return `harness      ${harness.kind.padEnd(6)}  ${state}`;
  });
  lines.push(
    preflight.ready
      ? 'harness      verified only that the manifest publishes these and this host can run them; not that they are signed in'
      : `! ${harnessAbsentWarning(preflight, clientName)}`,
  );
  return lines;
}
