import { z } from 'zod';
import { type CoreAccount, type HarnessKind, HarnessKindSchema } from './inventory.ts';

/**
 * Turning what the manifest publishes into something this host can execute.
 *
 * A PORT rather than a lookup at the point of use, because it is the one step in a start that
 * depends on the machine the daemon happens to be running on: a test proves the refusal a fleet
 * publishing an absent wrapper deserves without needing that wrapper installed to do it.
 *
 * It lives HERE, beside the launchability rule, rather than in the composition root where it began.
 * The rule and the lookup are one answer to one question — "could a start actually run this?" — and
 * a second declaration of either is a second notion of what "installed" means.
 *
 * THE TWO HALVES ARE DIFFERENT QUESTIONS and are deliberately not one method. An account is launched
 * by the ABSOLUTE path the manifest publishes, so {@link runnable} asks about a file. A harness's own
 * command (`claude`, `codex`) is published nowhere, so {@link resolve} asks the inherited environment
 * for it by name. Answering the first with the second is the defect this port was changed to remove: a
 * daemon started by a service manager inherits no shell profile, so a `PATH` lookup of a wrapper under
 * `<FY_HOME>/fleet/bin` could never succeed there.
 *
 * NEITHER HALF EVER RUNS ANYTHING. Both are a lookup and a stat, which is the whole reason a report
 * built from them may be printed at boot: launching an operator-named program to find out whether it
 * exists is not something a health check may do, and a `--version` that hangs would hang the boot.
 */
export interface ExecutableResolverPort {
  /** The absolute executable a bare NAME resolves to on this host's `PATH`, or `undefined`. */
  resolve(name: string): string | undefined;
  /** Whether this host can run the program at this absolute path right now. */
  runnable(path: string): boolean;
}

/**
 * A path an operator wrote down: absolute, or written against their own home.
 *
 * A RELATIVE PATH IS REFUSED AT PARSE TIME rather than searched. This daemon's working directory is
 * whatever a service manager handed it, so `bin/claude` names a different file depending on where the
 * unit happened to start — which is the same class of environment-dependent answer this whole block
 * exists to remove. `~` is expanded when the declaration is read, because an operator writing a path
 * by hand writes the one they type in a terminal.
 */
const DeclaredPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    value => value.startsWith('/') || value === '~' || value.startsWith('~/'),
    'must be an absolute path, or one written against ~',
  );

/**
 * WHERE THIS HOST'S HARNESSES ARE, as the operator has said it — the block `config/daemon.json`
 * carries under `harness`.
 *
 * IT EXISTS BECAUSE THE LOOKUP BELOW READS AN INHERITED ENVIRONMENT, and a daemon started by systemd
 * or launchd at login inherits a minimal one rather than the operator's interactive shell. `claude`
 * works perfectly in their terminal and is invisible to their daemon, and until this block there was
 * nothing they could write down to fix that — the CLI had solved exactly this for the daemon binary
 * itself with `FY_DAEMON_BIN`, and the harnesses got no equivalent.
 *
 * TWO KEYS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS. `paths` names one exact file and is the answer
 * for a host with a version manager, a shim, or two copies of a harness. `searchPaths` names
 * directories and is the answer for the service-managed case, where the daemon simply cannot see a
 * directory the login shell would have added — one line covers every harness, including one installed
 * after this was written.
 *
 * NO CREDENTIAL BELONGS HERE, and nothing in this block is one: a path is not a secret, and this file
 * travels into backups and screen shares exactly like the rest of the document it sits in.
 */
export const HarnessDiscoveryDocumentSchema = z
  .strictObject({
    /** The exact file to run for one harness. Absent means "search for it". */
    paths: z.partialRecord(HarnessKindSchema, DeclaredPathSchema).default({}),
    /** Directories to look in, in order, on top of whatever this daemon inherited. */
    searchPaths: z.array(DeclaredPathSchema).max(32).readonly().default([]),
  })
  .prefault({});

export type HarnessDiscoveryDocument = z.output<typeof HarnessDiscoveryDocumentSchema>;

/** The environment as this decision reads it: a variable name in, its value or nothing out. */
export type EnvironmentReader = (name: string) => string | undefined;

/**
 * The variable naming one harness's own command, derived from the harness kind rather than tabled.
 *
 * A SECOND SURFACE, NEVER THE ONLY ONE. A unit file can set an environment variable and cannot edit a
 * JSON document, which is the case this whole task came from; an operator with a shell can edit the
 * document and should not have to write a unit file. Offering only the variable would have moved the
 * problem rather than fixed it.
 */
function harnessPathVariable(kind: HarnessKind): string {
  return `FY_${kind.toUpperCase()}_BIN`;
}

/** The variable adding search directories, colon-separated, exactly as `PATH` itself is written. */
const HARNESS_SEARCH_PATH_VARIABLE = 'FY_HARNESS_PATH';

/** Where a declaration was written, so a report can send somebody to the line they need to change. */
export type HarnessDeclarationOrigin = 'configuration' | 'environment';

export interface HarnessDeclaration {
  /** The path itself, with `~` already expanded against the operator's home. */
  readonly value: string;
  readonly origin: HarnessDeclarationOrigin;
  /** The exact key that carries it — `harness.paths.claude`, or `FY_CLAUDE_BIN`. */
  readonly key: string;
}

/**
 * Everything an operator has said about where the harnesses are, from both surfaces at once.
 *
 * THE ENVIRONMENT WINS OVER THE DOCUMENT, per harness. Somebody repairing a service-managed daemon
 * edits the unit file, and a document that quietly outranked it would make that edit look ignored —
 * which is the exact silent-configuration failure this block was added to stop. Nothing is hidden by
 * the choice, because every report names the key that produced the answer.
 */
export interface HarnessDiscoveryPolicy {
  readonly explicit: Partial<Record<HarnessKind, HarnessDeclaration>>;
  /** Extra directories in search order: the environment's first, then the document's. */
  readonly searchDirectories: readonly HarnessDeclaration[];
}

/** An operator who has said nothing: every harness is looked for exactly where it always was. */
export const NO_HARNESS_DECLARATIONS: HarnessDiscoveryPolicy = { explicit: {}, searchDirectories: [] };

/** A `~` path as the operator means it. Absolute paths are returned untouched. */
function expandedHome(value: string, homeDirectory: string): string {
  if (value === '~') return homeDirectory;
  if (!value.startsWith('~/')) return value;
  return `${homeDirectory.replace(/\/+$/u, '')}/${value.slice(2)}`;
}

function declaration(value: string, origin: HarnessDeclarationOrigin, key: string, home: string): HarnessDeclaration {
  return { value: expandedHome(value.trim(), home), origin, key };
}

/**
 * The two surfaces read into one decision.
 *
 * A BLANK VARIABLE IS NOT A DECLARATION. A unit file that exports `FY_CLAUDE_BIN=` has said nothing,
 * and treating an empty string as an override would fail the boot's harness report with a path that
 * is not a path.
 *
 * AN ENVIRONMENT-SUPPLIED DIRECTORY IS NOT SCHEMA-CHECKED, because no schema stands between a unit
 * file and this reader. A relative one is kept rather than dropped: it finds nothing, and the report
 * names every directory that was searched, so an operator sees the entry they wrote. Dropping it
 * silently would leave them looking at a report that does not mention the line they are staring at.
 */
export function harnessDiscoveryPolicy(input: {
  readonly document: HarnessDiscoveryDocument;
  readonly environment: EnvironmentReader;
  readonly homeDirectory: string;
}): HarnessDiscoveryPolicy {
  const explicit: Partial<Record<HarnessKind, HarnessDeclaration>> = {};
  for (const kind of HarnessKindSchema.options) {
    const variable = harnessPathVariable(kind);
    const declared = input.environment(variable)?.trim();
    const written = input.document.paths[kind]?.trim();
    if (declared !== undefined && declared !== '')
      explicit[kind] = declaration(declared, 'environment', variable, input.homeDirectory);
    else if (written !== undefined && written !== '')
      explicit[kind] = declaration(written, 'configuration', `harness.paths.${kind}`, input.homeDirectory);
  }
  const inherited = (input.environment(HARNESS_SEARCH_PATH_VARIABLE) ?? '')
    .split(':')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
    .map(entry => declaration(entry, 'environment', HARNESS_SEARCH_PATH_VARIABLE, input.homeDirectory));
  const written = input.document.searchPaths.map(entry =>
    declaration(entry, 'configuration', 'harness.searchPaths', input.homeDirectory),
  );
  return { explicit, searchDirectories: [...inherited, ...written] };
}

/** Which rule produced a path. Reported everywhere the path is, because a path alone is not an answer. */
export type HarnessResolutionRule = 'explicit override' | 'extra search path' | 'inherited environment';

/**
 * Where one harness's own command is on this host, and WHY it is that file.
 *
 * `override-absent` IS ITS OWN OUTCOME rather than a failed search. An operator who names a path has
 * told this daemon something specific; falling back to a search from there would find some other
 * `claude`, report a success, and leave them believing they had configured something they had not.
 * So a named path that this host cannot run is a stated failure that names the key to fix.
 */
export type HarnessLocation =
  | {
      readonly kind: HarnessKind;
      readonly outcome: 'located';
      readonly path: string;
      readonly rule: HarnessResolutionRule;
      /** The key, directory list or `PATH` the answer came out of. */
      readonly declaredBy: string;
    }
  | {
      readonly kind: HarnessKind;
      readonly outcome: 'override-absent';
      readonly path: string;
      readonly declaredBy: string;
      readonly reason: string;
    }
  | { readonly kind: HarnessKind; readonly outcome: 'absent'; readonly searched: readonly string[] };

/** One directory's candidate for a harness command, with the separator written exactly once. */
function candidateIn(directory: string, name: string): string {
  return `${directory.replace(/\/+$/u, '')}/${name}`;
}

/**
 * The ONE resolution rule, in the order an operator would expect it: what they named, then where they
 * said to look, then what this daemon happened to inherit.
 *
 * NOTHING IS LAUNCHED HERE. Every step is a lookup or a stat — see {@link ExecutableResolverPort} —
 * so this is safe to call from a boot milestone and from a report a browser asks for.
 */
export function locateHarnessCommand(
  kind: HarnessKind,
  policy: HarnessDiscoveryPolicy,
  executables: ExecutableResolverPort,
): HarnessLocation {
  const override = policy.explicit[kind];
  if (override !== undefined) {
    if (executables.runnable(override.value))
      return { kind, outcome: 'located', path: override.value, rule: 'explicit override', declaredBy: override.key };
    return {
      kind,
      outcome: 'override-absent',
      path: override.value,
      declaredBy: override.key,
      reason: `${override.key} names ${override.value} for ${kind} and this host cannot run that file — nothing else was searched, because a path somebody wrote down is an instruction rather than a preference; correct it or remove it`,
    };
  }
  for (const directory of policy.searchDirectories) {
    const candidate = candidateIn(directory.value, kind);
    if (executables.runnable(candidate))
      return { kind, outcome: 'located', path: candidate, rule: 'extra search path', declaredBy: directory.key };
  }
  const inherited = executables.resolve(kind);
  if (inherited !== undefined)
    return { kind, outcome: 'located', path: inherited, rule: 'inherited environment', declaredBy: 'PATH' };
  return { kind, outcome: 'absent', searched: policy.searchDirectories.map(entry => entry.value) };
}

/**
 * What a missing harness costs, in one sentence, from ONE owner.
 *
 * Every surface that reports an absence says this same thing, because the doctor report's own promise
 * is "programs this daemon host needs, and what each absence breaks" and a second spelling of the
 * consequence is how two surfaces come to disagree about what is broken.
 */
export function harnessAbsenceImpact(kind: HarnessKind): string {
  return `A wrapper the fleet publishes for a ${kind} account runs \`${kind}\`, so no ${kind} session can start on this host. Accounts on the other harness are unaffected.`;
}

/** One location as a person reads it: the file, and the rule that chose it. */
export function harnessLocationLine(location: HarnessLocation): string {
  if (location.outcome === 'located') return `${location.path}  (${location.rule} — ${location.declaredBy})`;
  if (location.outcome === 'override-absent') return `not usable — ${location.reason}`;
  return location.searched.length === 0
    ? 'not found in the inherited environment, and no extra search path is declared'
    : `not found in the inherited environment, nor in ${location.searched.join(', ')}`;
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
  // The manifest publishes the wrapper's ABSOLUTE path and the lifecycle demands one, so the path is
  // taken rather than reconstructed: the wrapper authorization is what stops this daemon launching
  // anything else, and a name resolved against PATH could resolve to a different program entirely.
  // Whether this host can actually run that file is the one thing the manifest cannot declare.
  if (!executables.runnable(account.wrapper))
    return {
      kind: 'absent-executable',
      reason: `the fleet publishes ${account.agent} at ${account.wrapper}, but this host cannot run that file — provisioning may not have run here, or the fleet's state home is not the one this daemon reads`,
    };
  return { kind: 'launchable', executable: account.wrapper };
}

/** One harness, as a boot can see it without launching anything. */
export interface HarnessReadiness {
  readonly kind: HarnessKind;
  /** Wrapper names a start could resolve right now. */
  readonly launchable: readonly string[];
  /** Every published account this harness has that a start could NOT resolve, and why. */
  readonly blocked: readonly string[];
  /**
   * Where the harness's own command is on this host — a WEAKER and different fact.
   *
   * It is reported because of the one genuinely confusing case: somebody installs Claude Code, is
   * told no harness is ready, and is right to object. This daemon does not launch `claude`; it
   * launches the wrappers the fleet manifest publishes, so an installed harness with no declared
   * account is invisible to a start no matter how present it is. Saying "installed, but no account
   * is published for it" turns a report that looks wrong into one that names the missing step.
   *
   * THE WHOLE LOCATION RATHER THAN A BOOLEAN, because a boolean was never enough to act on. Which
   * `claude` was found, and which rule found it, is the difference between an operator's override
   * having taken effect and their having edited a key nothing reads — and the path was being computed
   * and thrown away.
   *
   * The name comes from {@link HarnessKind} itself rather than a second table, so there is nothing
   * here that can disagree with the kind an account declares.
   */
  readonly command: HarnessLocation;
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
  /**
   * Why the manifest itself could not be read, when it could not be.
   *
   * A SEPARATE FIELD rather than an empty fleet or a blocked account, because it is a different
   * fact from either. "No account is published" is a claim about a file this daemon read; "the
   * manifest could not be read" is the admission that it has no idea what is published. Reporting
   * the second as the first is precisely how a daemon came to tell an operator their fleet
   * published nothing while the CLI listed a provisioned account from the same bytes.
   */
  readonly manifestRefusal?: string;
}

export function readHarnessPreflight(
  accounts: readonly CoreAccount[],
  executables: ExecutableResolverPort,
  policy: HarnessDiscoveryPolicy,
): HarnessPreflight {
  const harnesses = HarnessKindSchema.options.map((kind): HarnessReadiness => {
    const launchable: string[] = [];
    const blocked: string[] = [];
    for (const account of accounts.filter(row => row.kind === kind)) {
      const launchability = accountLaunchability(account, executables);
      if (launchability.kind === 'launchable') launchable.push(account.agent);
      else blocked.push(launchability.reason);
    }
    return { kind, launchable, blocked, command: locateHarnessCommand(kind, policy, executables) };
  });
  return { harnesses, ready: harnesses.some(harness => harness.launchable.length > 0) };
}

/**
 * The preflight a manifest this daemon cannot read earns: nothing launchable, nothing claimed about
 * any account, and the refusal carried as what it is.
 *
 * `blocked` stays EMPTY deliberately. A blocked entry means "this published account cannot be
 * launched, and here is why", and there is no honest way to say that about accounts whose file
 * would not parse. The harness commands are still reported, because whether Claude Code is
 * installed on this host is a fact the manifest has no bearing on.
 */
export function unreadableManifestPreflight(
  refusal: string,
  executables: ExecutableResolverPort,
  policy: HarnessDiscoveryPolicy,
): HarnessPreflight {
  return {
    harnesses: HarnessKindSchema.options.map(kind => ({
      kind,
      launchable: [],
      blocked: [],
      command: locateHarnessCommand(kind, policy, executables),
    })),
    ready: false,
    manifestRefusal: refusal,
  };
}

/**
 * WHERE EACH HARNESS COMMAND IS, as one line a boot milestone carries beside the account summary.
 *
 * IT IS SAID EVERY TIME, not only when something is wrong. A daemon that reports a resolved path only
 * on failure cannot answer the question an operator actually asks — "is my override in effect?" — and
 * a person who has just added `harness.searchPaths` learns nothing from silence. The rule is printed
 * with the path for the same reason: two hosts resolving `claude` to the same file for different
 * reasons are not in the same state, and only one of them survives the next login.
 */
export function harnessLocationSummary(preflight: HarnessPreflight): string {
  return preflight.harnesses.map(harness => `${harness.kind}: ${harnessLocationLine(harness.command)}`).join('; ');
}

/**
 * Every explicit override that names a file this host cannot run.
 *
 * SEPARATE FROM THE SUMMARY, because it is the one harness fact that must not be filtered by a log
 * level. An operator in this state has configured something and been given nothing; the whole reason
 * the override refuses to fall back is so this sentence gets said.
 */
export function harnessOverrideFailures(preflight: HarnessPreflight): readonly string[] {
  return preflight.harnesses
    .map(harness => harness.command)
    .filter(location => location.outcome === 'override-absent')
    .map(location => `${location.reason}. ${harnessAbsenceImpact(location.kind)}`);
}

/** The one-line detail a boot milestone carries: what was found, per harness, in a glance. */
export function harnessPreflightSummary(preflight: HarnessPreflight): string {
  if (preflight.manifestRefusal !== undefined) return 'unknown — the fleet manifest could not be read';
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
  // A manifest that would not parse says nothing about accounts, so nothing below it is said either:
  // the refusal already names the file, the failure and the consequence.
  if (preflight.manifestRefusal !== undefined)
    return `no agent harness can be resolved on this host, so this daemon can serve its API but cannot start a session: ${preflight.manifestRefusal}`;
  const blocked = preflight.harnesses.flatMap(harness => harness.blocked);
  const installed = preflight.harnesses
    .filter(harness => harness.command.outcome === 'located')
    .map(harness => harness.kind);
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
  const lines = preflight.harnesses.flatMap(harness => {
    const located = harness.command.outcome === 'located';
    const state =
      preflight.manifestRefusal !== undefined
        ? // Not "no account published": this daemon does not know what is published.
          `unknown — the fleet manifest could not be read (the ${harness.kind} command ${located ? 'is' : 'is not'} resolvable)`
        : harness.launchable.length > 0
          ? `ready — ${harness.launchable.join(', ')}`
          : harness.blocked.length > 0
            ? `not usable — ${harness.blocked.join('; ')}`
            : located
              ? // Named apart from the plain absence, because it is a different missing step: the
                // harness is here, the account that would let this daemon launch it is not.
                `no account published (the ${harness.kind} command resolves, but this daemon launches published wrappers)`
              : 'no account published, and the command could not be resolved';
    return [
      `harness      ${harness.kind.padEnd(6)}  ${state}`,
      // The location on its OWN line, always. It answers a different question from the one above it —
      // "which file, and why that one" rather than "could a session start" — and an operator reading
      // this command is usually here because those two answers have stopped agreeing.
      `command      ${harness.kind.padEnd(6)}  ${harnessLocationLine(harness.command)}`,
      ...(located ? [] : [`             ${harness.kind.padEnd(6)}  ${harnessAbsenceImpact(harness.kind)}`]),
    ];
  });
  lines.push(
    preflight.ready
      ? 'harness      verified only that the manifest publishes these and this host can run them; not that they are signed in'
      : `! ${harnessAbsentWarning(preflight, clientName)}`,
  );
  return lines;
}
