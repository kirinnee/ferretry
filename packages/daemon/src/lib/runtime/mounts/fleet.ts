import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative as relative_, sep } from 'node:path';
import {
  buildFleetHealthCollector,
  buildFleetScaffold,
  buildFleetUsageCollector,
  FleetApplyFailureError,
  type FleetApplyPlan,
  type FleetApplyPreview,
  type FleetApplyResult,
  type FleetConfig,
  FleetConfigSchema,
  type FleetDocumentWrite,
  type FleetHealthProbe,
  type FleetHealthSnapshot,
  type FleetLayout,
  type FleetManifest,
  FleetManifestSchema,
  FleetPlan,
  type FleetScaffold,
  type FleetScaffolder,
  FleetScaffoldPartialError,
  type FleetUsageProbe,
  type FleetUsageSnapshot,
  resolveFleetSharing,
  SharedHistoryMigration,
} from '@ferretry/fleet';
import {
  AnthropicUsageProbe,
  FileFleetConfigSource,
  FileFleetProvisioner,
  FileFleetScaffolder,
  FileSharedHistoryFileSystem,
  fetchQuota,
  fleetApplyLockFor,
  PlatformFleetCredentialStore,
  ProcessFleetHealthProbe,
  runFleetHealthProcess,
  SpawnCredentialCommand,
} from '@ferretry/fleet/adapters';
/**
 * Every wire shape this mount answers with is the shared one.
 *
 * The daemon, the command line and the browser all read the same declarations, so a field cannot
 * be added on one side and quietly missed on another. A consumer that needs one of these shapes
 * takes it from the protocol package, as this mount does, rather than from the mount itself.
 */
import {
  type FleetApplyOutcome,
  FleetApplyOutcomeSchema,
  FleetAssetDocumentSchema,
  FleetAssetIndexSchema,
  FleetManifestSummarySchema,
  type FleetPermissions,
  FleetPermissionsSchema,
  type FleetProposalApplyRequest,
  FleetProposalApplyRequestSchema,
  type FleetProposalRequest,
  FleetProposalRequestSchema,
  type FleetProposalView,
  FleetProposalViewSchema,
  type FleetSharing as FleetWireSharing,
  FleetSharingSchema,
  type HarnessDiscoveryReport,
  HarnessDiscoveryReportSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import { MAX_TEXT_BODY_BYTES, parseBody, parseOptionalBody } from '../../api/body.ts';
import type { CallerGovernance, ChangeConfirmation } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import { type FleetAssetDocument, FleetAssetStore, type FleetAssetTree } from '../../fleet/asset-store.ts';
import {
  ABSENT_ASSET_REVISION,
  type FleetAssetEdit,
  FleetAssetRefusal,
  type FleetAssetRevision,
  parseAssetEdits,
} from '../../fleet/assets.ts';
import {
  applyFleetMutation,
  derivedWrapperName,
  type FleetMutation,
  FleetMutationRefusal,
} from '../../fleet/mutations.ts';
import { planSharedAssetUnlink, sharingSummary } from '../../fleet/sharing.ts';
import {
  type FleetProposalProblem,
  type FleetProposalRecord,
  FleetProposalRefusal,
  FleetProposalStore,
  MISSING_CONFIG_REVISION,
  redactProposal,
} from '../../fleet/proposals.ts';
import type { HarnessDiscoveryReader } from '../../fleet/harness-discovery.ts';
import {
  applyResultSummary,
  committedSummary,
  manifestSummary,
  planSummary,
  scaffoldSummary,
} from '../../fleet/wire.ts';
import type { FoundationPaths } from '../../paths.ts';
import type { FileSystemPort } from '../../ports.ts';
import type { SessionRootPinner } from '../../session/filesystem/ports.ts';

/**
 * The daemon front door over the shared fleet library.
 *
 * These routes expose validated evidence, the pure shared plan, the last manifest that apply
 * published, and the shared provisioner that can make that plan real.
 *
 * There is now an account editor and an asset editor here, and the safety argument that used to
 * justify their absence has been replaced rather than dropped:
 *
 * - **Nothing a caller sends is a configuration.** It sends one named intent — prepare this host,
 *   add an account, change that account — and the daemon derives the next configuration itself. An
 *   arbitrary document could differ from what was reviewed in ways nobody reads.
 * - **Nothing is written until a change has been reviewed.** Composing a change writes nothing at
 *   all; applying consumes the exact artifact that produced the preview, never a rebuilt one.
 * - **Pairing is still not provisioning**, and WHO decides that is no longer this file's business.
 *   Every route below declares its `fleet` axis and the authorization boundary enforces it, exactly
 *   as it does for the other five capabilities. This mount used to re-decide the same question in
 *   four inline `tokenClass === 'device'` refusals and a private approval system — codes the host
 *   minted, a 120-second life, a wrong-try budget — which was a second authority model wearing the
 *   fleet's name, invisible to the route table and to `GrantsView`, so no surface could explain a
 *   refusal before somebody clicked. It is gone; see `docs/design/fleet-authority-unification.md`.
 * - **A governed caller confirms each change**, where this machine has an operator password. That is
 *   the one thing added rather than removed, and it is not a credential of its own: it is the same
 *   password the unlock is made of, proved against one exact staged artifact so that a borrowed
 *   five-minute unlock cannot by itself write executables into somebody's home.
 *
 * The declared YAML remains an operator-owned local document: it is round-tripped through the
 * shared schema, so comments and anchors in a hand-written file do not survive the first edit made
 * from a browser. That is disclosed to the person before they approve, not hidden here.
 */

export interface FleetSubsystem {
  /** The complete last-published manifest, not a wrapper-directory reconstruction. */
  accounts(): Promise<FleetManifest>;
  config(): Promise<FleetConfig>;
  /**
   * What this host already knows about each harness, so a form does not ask for it.
   *
   * Read fresh, and deliberately NOT part of the manifest read: the manifest says what this fleet
   * publishes, while this says what the machine has. Somebody installing Claude Code for the first
   * time has the second and none of the first, and that is precisely the person filling in this form.
   */
  harnesses(): Promise<HarnessDiscoveryReport>;
  /** The deliberately narrow, remotely-safe profile environment editor. */
  environment(): Promise<FleetEnvironmentView>;
  updateEnvironment(request: FleetEnvironmentUpdate): Promise<FleetEnvironmentView>;
  plan(): Promise<FleetApplyPreview>;
  usage(): Promise<FleetUsageSnapshot>;
  /** Explicit liveness evidence, keyed to this daemon's FY_HOME. */
  health(): Promise<FleetHealthSnapshot>;
  apply(): Promise<FleetApplyResult>;
  /** What this caller may do here, so the surface can say so before a click. */
  permissions(governance: CallerGovernance | undefined): FleetPermissions;
  /** Text assets the fleet copies into account homes, bounded to this daemon's asset tree. */
  assets(): Promise<FleetAssetTree>;
  asset(path: string): Promise<FleetAssetDocument>;
  /** Which documents this fleet shares, and whether each account uses one or its own copy. */
  sharing(): Promise<FleetWireSharing>;
  /** Derive, preview and hold a change. Writes nothing. */
  propose(request: FleetProposalRequest): Promise<FleetProposalView>;
  readProposal(id: string): Promise<FleetProposalView>;
  /** Apply exactly the held proposal, never a rebuilt one. */
  applyProposal(
    id: string,
    request: FleetProposalApplyRequest,
    governance: CallerGovernance | undefined,
  ): Promise<FleetApplyOutcome>;
}

/**
 * What a reviewer is shown: a real plan, or the first-run scaffold that has no plan yet.
 *
 * `documents` names the configuration and asset writes by path and size. Reviewing "every write
 * before it happens" has to include the ones that are not plan operations, and the text itself is
 * what the reviewer just composed, so its length is the useful fact rather than its content.
 */
/**
 * The artifact a proposal holds. Built once, at review time, and consumed unchanged.
 *
 * The preview is kept beside the plan that produced it rather than re-derived, because a rebuilt
 * plan carries a fresh `generatedAt` at minimum — so the manifest that landed would differ from the
 * one that was read, and every filesystem-sensitive fact in the preview could have moved too.
 */
type FleetProposalPayload =
  | {
      readonly kind: 'apply';
      readonly plan: FleetApplyPlan;
      readonly preview: FleetApplyPreview;
      readonly documents: readonly FleetDocumentWrite[];
    }
  | {
      readonly kind: 'initialize';
      readonly scaffold: FleetScaffold;
      readonly documents: readonly FleetDocumentWrite[];
    };

interface FleetRouteClock {
  now(): number;
}

export interface DaemonFleetOptions {
  readonly paths: FoundationPaths;
  readonly userHome: string;
  readonly clock: FleetRouteClock;
  /** The state filesystem owns the durable, atomic replacement of config.yaml. */
  readonly files: Pick<FileSystemPort, 'writeTextAtomic'>;
  readonly usageProbe?: FleetUsageProbe;
  readonly healthProbe?: FleetHealthProbe;
  /**
   * This host's platform, spelled the way the Node runtime spells it, and the keychain `acct` attribute the
   * credential store falls back to on macOS. Both are supplied rather than read: the composition root
   * is the only place allowed to touch the environment, and injecting them is what lets a test drive
   * the macOS credential path on a host that is not macOS.
   */
  readonly platform: string;
  readonly keychainAccount?: string;
  /** 22 URL-safe characters for a proposal handle. Supplied, so identity is never clock-derived. */
  readonly mintId: () => string;
  /** A fresh account identifier. Minted by the daemon so no caller can choose or collide with one. */
  readonly mintUuid: () => string;
  /**
   * Proves the operator password for ONE change, for the caller the boundary said owes a
   * confirmation.
   *
   * INJECTED, and deliberately not the grant subsystem itself. This mount must be able to ask
   * "was this password right" without being able to read one, hold one, or reach anything else the
   * grant service can do — the same use-never-read shape the secret store is built on. The
   * composition root satisfies it with `CapabilityGrantService.confirmChange`, so the attempt this
   * spends is one of the same five an unlock spends and no second budget exists.
   */
  readonly confirmChange: (password: string) => Promise<ChangeConfirmation>;
  /**
   * What a person types to run this binary, so a refusal names a command they actually have.
   *
   * Injected for the same reason the grant subsystem takes one: the binary name is single-sourced
   * from `packages/cli/package.json`'s `bin` key, and a mount that spelled it itself would be a
   * second owner of a fact a rename script is supposed to move in one place.
   */
  readonly clientName: string;
  /**
   * Holds a directory open so nothing can be substituted underneath it. Supplied rather than
   * chosen here because the implementation is platform-specific, and one that cannot pin must fail
   * rather than fall back to a pathname — the fallback reopens the hole this closes.
   */
  readonly rootPinner: SessionRootPinner;
  /**
   * What this host knows about a harness before anything is launched.
   *
   * INJECTED, because assembling it needs the two things this layer may not reach for: where each
   * harness keeps its own files on a real machine, and a read that leaves the state home — the state
   * filesystem refuses every path outside `FY_HOME`, which is right for it and useless for reading
   * somebody's `~/.claude`.
   */
  readonly harnesses: HarnessDiscoveryReader;
  /**
   * Writes a first run to the host. Defaulted to the file implementation, and overridable because
   * this mount has to answer for what any implementation of the port does: the file one reports
   * every failure it can reach as a partial host, and the handling of one that does not — a claim
   * left behind by a failure nobody classified — is exactly the part that must be provable.
   */
  readonly scaffolder?: FleetScaffolder;
}

/** Configuration and assets are private: they name homes, wrappers and everything an account runs. */
const CONFIG_MODE = 0o600;
const ASSET_MODE = 0o600;

const EnvironmentSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string());
const FleetEnvironmentUpdateSchema = z
  .strictObject({
    profile: z.string().trim().min(1),
    environment: EnvironmentSchema,
    mode: z.enum(['merge', 'replace']),
  })
  .readonly();

type FleetEnvironmentUpdate = z.output<typeof FleetEnvironmentUpdateSchema>;

interface FleetEnvironmentView {
  readonly profiles: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const SENSITIVE_ENVIRONMENT_NAME = /(?:api[_-]?key|credential|password|secret|token|auth)/iu;
const MACHINE_ENVIRONMENT_NAME = /(?:^|_)(?:address|host(?:name)?|home|path|port)(?:$|_)/iu;
const MACHINE_ENVIRONMENT_VALUE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[/~]|[A-Za-z]:[\\/])/iu;

/** Environment values are configuration only when they can travel safely. Credentials, local
 * paths, addresses and ports must stay on the machine that owns them. Refusing the entire profile
 * is intentional: presenting a redacted value as a copyable one invites an accidental deletion. */
function portableEnvironment(environment: Readonly<Record<string, string>>, profile: string): Record<string, string> {
  for (const [name, value] of Object.entries(environment)) {
    if (SENSITIVE_ENVIRONMENT_NAME.test(name))
      throw new FleetRefusal(
        'fleet_environment_refused',
        `profile ${profile} contains credential-like ${name}; it is not remotely editable or copyable`,
      );
    if (MACHINE_ENVIRONMENT_NAME.test(name) || MACHINE_ENVIRONMENT_VALUE.test(value))
      throw new FleetRefusal(
        'fleet_environment_refused',
        `profile ${profile} contains machine-bound ${name}; it is not remotely editable or copyable`,
      );
  }
  return { ...environment };
}

type FleetRefusalCode =
  | 'fleet_config_missing'
  | 'fleet_config_invalid'
  | 'fleet_not_applied'
  | 'fleet_manifest_invalid'
  | 'fleet_plan_refused'
  | 'fleet_apply_refused'
  | 'fleet_environment_refused'
  | 'fleet_asset_refused'
  | 'fleet_proposal_refused'
  | 'fleet_proposal_unknown'
  | 'fleet_proposal_expired'
  | 'fleet_proposal_consumed'
  | 'fleet_proposal_unauthorized'
  | 'fleet_proposal_stale';

/** An expected, operator-actionable refusal rather than an internal daemon defect. */
class FleetRefusal extends Error {
  constructor(
    readonly code: FleetRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'FleetRefusal';
  }
}

const PROPOSAL_CODES: Record<FleetProposalProblem, FleetRefusalCode> = {
  unknown: 'fleet_proposal_unknown',
  expired: 'fleet_proposal_expired',
  consumed: 'fleet_proposal_consumed',
  exhausted: 'fleet_proposal_refused',
};

/** One line naming what is being approved, derived from the change rather than from the caller. */
function summarize(mutation: FleetMutation, candidate: FleetConfig): string {
  if (mutation.kind === 'initialize') return 'prepare this host for a fleet';
  if (mutation.kind === 'create-account') {
    return `add ${derivedWrapperName(mutation.harness, mutation.name, mutation.variant ?? 'default')}`;
  }
  const wrapper = wrapperOf(candidate, mutation.accountId);
  // A sharing change says which document and which direction, because "change claude-work" is not
  // enough for somebody deciding whether to approve a switch of every account's instructions.
  if (mutation.kind === 'link-shared-asset') {
    return `link ${wrapper ?? mutation.accountId} ${mutation.field} to the shared "${mutation.name}"`;
  }
  if (mutation.kind === 'unlink-shared-asset') {
    return `give ${wrapper ?? mutation.accountId} its own ${mutation.field}`;
  }
  return wrapper === undefined ? `change account ${mutation.accountId}` : `change ${wrapper}`;
}

/** The wrapper name of one account in a candidate configuration, found by id. */
function wrapperOf(candidate: FleetConfig, accountId: string): string | undefined {
  for (const agent of candidate.agents) {
    for (const route of Object.values(agent.routes)) {
      if (route.id === accountId) return route.wrapper;
    }
  }
  return undefined;
}

/** Report a first run in the same shape as an apply, so one result panel renders both. */
function applyOutcomeOf(error: FleetApplyFailureError): FleetApplyOutcome {
  const failure = error.failure;
  // Residue travels with every outcome. A claim nobody cleared blocks the next apply whatever else
  // happened, so dropping it would leave a person with a fleet that silently refuses to change.
  const residue = error.lockResidue === undefined ? {} : { lockResidue: error.lockResidue };
  if (failure.kind === 'history-failed-after-commit') {
    return {
      outcome: 'committed-with-history-failure',
      failedHarness: failure.failedHarness,
      reason: failure.reason,
      committed: committedSummary(failure.committed),
      ...residue,
    };
  }
  if (failure.kind === 'rollback-incomplete') {
    return {
      outcome: 'rollback-incomplete',
      failedOperation: failure.failedOperation,
      reason: failure.reason,
      unrestored: failure.unrestored.map(entry => ({ ...entry })),
      ...(failure.displaced === undefined ? {} : { displaced: failure.displaced.map(entry => ({ ...entry })) }),
      ...residue,
    };
  }
  return { outcome: 'rolled-back', failedOperation: failure.failedOperation, reason: failure.reason, ...residue };
}

/**
 * Where the asset tree sits beneath the state home, as the pinned walk names it.
 *
 * Derived rather than spelled, so the two can never disagree — and refused outright if the asset
 * directory is somehow not inside the home, because then there is no trusted ancestor to pin and
 * failing closed is the only honest answer.
 */
function relativeAssetPrefix(home: string, assetsDirectory: string): string {
  const relative = relative_(home, assetsDirectory);
  if (relative === '' || relative.startsWith('..') || isAbsolute(relative)) {
    throw new Error(`the fleet asset directory ${assetsDirectory} is not inside the state home ${home}`);
  }
  return relative.split(sep).join('/');
}

function fleetLayout(paths: FoundationPaths, userHome: string): FleetLayout {
  return {
    stateHome: paths.home,
    userHome,
    fleetDirectory: paths.fleet,
    binDirectory: join(paths.fleet, 'bin'),
    homesDirectory: join(paths.fleet, 'homes'),
    assetsDirectory: join(paths.fleet, 'assets'),
    manifestPath: paths.fleetManifest,
    defaultHomeDirectories: { claude: join(userHome, '.claude'), codex: join(userHome, '.codex') },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function missingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

class MountedFleet implements FleetSubsystem {
  private readonly configPath: string;
  private readonly layout: FleetLayout;
  private readonly configSource: FileFleetConfigSource;
  private readonly planner = new FleetPlan();
  private readonly provisioner: FileFleetProvisioner;
  private readonly scaffolder: FleetScaffolder;
  private readonly assetStore: FleetAssetStore;
  private readonly proposals: FleetProposalStore<FleetProposalPayload>;

  constructor(private readonly options: DaemonFleetOptions) {
    this.layout = fleetLayout(options.paths, options.userHome);
    this.configPath = join(options.paths.fleet, 'config.yaml');
    this.configSource = new FileFleetConfigSource(this.configPath);
    // FleetPlan may target both FY_HOME (the generated fleet) and explicit/default harness homes
    // under the user home. Those are the only two roots this daemon declares writable; an absolute
    // account home elsewhere remains visible in GET /plan and is refused by the shared adapter.
    const allowedRoots = [options.paths.home, options.userHome];
    this.provisioner = new FileFleetProvisioner(
      allowedRoots,
      new SharedHistoryMigration(new FileSharedHistoryFileSystem(allowedRoots)),
    );
    this.scaffolder = options.scaffolder ?? new FileFleetScaffolder(allowedRoots);
    this.assetStore = new FleetAssetStore({
      // The state home, not the asset directory: the thing being guarded must never be its own
      // guard. Pinning `fleet/assets` would follow a link swapped in for it a moment earlier and
      // then walk somebody else's tree perfectly safely.
      trustedRoot: options.paths.home,
      assetsPrefix: relativeAssetPrefix(options.paths.home, this.layout.assetsDirectory),
      assetsDirectory: this.layout.assetsDirectory,
      pinner: options.rootPinner,
    });
    this.proposals = new FleetProposalStore<FleetProposalPayload>({
      now: () => this.options.clock.now(),
      mintId: () => this.options.mintId(),
    });
  }

  /**
   * What this caller may do, so the surface can render a truthful state before a click.
   *
   * ## IT PROJECTS THE CAPABILITY LAYER'S ANSWER; IT DOES NOT PRODUCE A SECOND ONE
   *
   * `mayApply` and `applyRefusal` are literally `decideCapability({ fleet, configure })` for this
   * request, asked through the governance the authorization boundary already built. They used to be
   * derived from `tokenClass` here, which meant the panel and the boundary held two independent
   * opinions about one question: a paired device was told `mayApplyDirectly: false` while the route
   * table declared `capability: fleet.configure` and the operator's grants said a third thing. The
   * refusal travels with the answer because `false` has four different remedies and a panel showing
   * one sentence for all four is the dead end this surface exists to remove.
   *
   * `mayInspect` and `mayPropose` are the `use` axis, ASKED rather than hardcoded to the `true` a
   * caller who reached this route has already proved. They will not differ in practice — the route
   * itself demands `fleet.use` — and asking anyway is what keeps this function a projection of one
   * decision rather than a mixture of a decision and an assumption about the route table.
   *
   * AN ABSENT GOVERNANCE IS THE STRICTER READING. It cannot arise through the served route, which
   * declares a capability and therefore always has one built — but "nobody could tell me where this
   * caller stands" must never render as an open Apply button, or as a panel that promises a read.
   */
  permissions(governance: CallerGovernance | undefined): FleetPermissions {
    if (governance === undefined)
      return {
        mayInspect: false,
        mayPropose: false,
        mayApply: false,
        applyRefusal: 'undetermined',
        confirmation: 'none',
      };
    const use = governance.decide({ capability: 'fleet', axis: 'use' });
    const configure = governance.decide({ capability: 'fleet', axis: 'configure' });
    return {
      mayInspect: use.allowed,
      mayPropose: use.allowed,
      mayApply: configure.allowed,
      applyRefusal: configure.refusal,
      // Reported even when `mayApply` is false, because it is a fact about the machine rather than
      // about this attempt: a caller that unlocks and comes back still owes the confirmation, and a
      // panel that learned that only after the unlock would have to re-word itself mid-flow.
      confirmation: governance.confirmChange ? 'operator-password' : 'none',
    };
  }

  async assets(): Promise<FleetAssetTree> {
    return await this.withAssetRefusals(() => this.assetStore.list());
  }

  async asset(path: string): Promise<FleetAssetDocument> {
    return await this.withAssetRefusals(() => this.assetStore.read(path));
  }

  /**
   * Turn an expected asset refusal into the fleet's own refusal grammar.
   *
   * Without this a missing file, a link, a binary or an over-limit read escapes as an unhandled
   * error and becomes a 500 with its message stripped — so the caller is told the daemon broke when
   * in fact it declined, and is given nothing to act on.
   */
  private async withAssetRefusals<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof FleetAssetRefusal) throw new FleetRefusal('fleet_asset_refused', error.message);
      throw error;
    }
  }

  /**
   * Derive a change, preview it, and hold it — without writing anything.
   *
   * The revision the change was derived from is recorded now and checked at apply time, so a
   * configuration edited on the host in between refuses rather than silently applying a preview
   * that no longer describes the change.
   */
  async propose(request: FleetProposalRequest): Promise<FleetProposalView> {
    // Every refusal this composes — a bad asset path, a bound, a proposal-store limit — is one the
    // caller can act on, so all of them travel as the fleet's own grammar rather than escaping as
    // an unhandled error the API layer would strip to a bare 500.
    return await this.withProposalRefusals(async () => await this.compose(request));
  }

  private async compose(request: FleetProposalRequest): Promise<FleetProposalView> {
    if (request.mutation.kind === 'initialize') return await this.composeInitialization(request);
    return await this.composeChange(request, request.mutation);
  }

  /**
   * Prepare a host that has no fleet at all.
   *
   * Split from the change path because the two differ in what they are allowed to read: this one must
   * not read a configuration, since its whole precondition is that there is none.
   */
  private async composeInitialization(request: FleetProposalRequest): Promise<FleetProposalView> {
    const assetEdits = parseAssetEdits(request.assetEdits ?? []);
    const assetRevisions = await this.pinnedRevisions(assetEdits.map(edit => edit.path));
    const revision = await this.revision();
    if (revision !== MISSING_CONFIG_REVISION) {
      throw new FleetRefusal(
        'fleet_proposal_refused',
        `this host already has a fleet configuration at ${this.configPath}; initialization is for a host that has none`,
      );
    }
    if (assetEdits.length > 0) {
      // Two commit boundaries — a create-if-absent scaffold and a rollback-protected asset write —
      // cannot be reported as one truthful outcome, and the half where the scaffold landed and the
      // assets did not has no honest name. Preparing the host is its own step; edit afterwards.
      throw new FleetRefusal(
        'fleet_proposal_refused',
        'preparing a host cannot carry asset edits; prepare the fleet first, then edit its assets',
      );
    }
    return this.viewOf(
      this.proposals.open({
        revision,
        mutation: request.mutation,
        assetEdits,
        assetRevisions,
        payload: { kind: 'initialize', scaffold: this.scaffold(), documents: [] },
        summary: 'prepare this host for a fleet',
      }),
    );
  }

  private async composeChange(
    request: FleetProposalRequest,
    mutation: Exclude<FleetMutation, { kind: 'initialize' }>,
  ): Promise<FleetProposalView> {
    // Read once for the whole composition. An unlink derives a text document from the configuration
    // *and* derives the next configuration from it, and two reads could disagree — the private copy
    // would then be seeded from a document the candidate no longer points at.
    const current = await this.config();
    const derived = await this.derivedAssetEdits(current, mutation);
    const assetEdits = parseAssetEdits([...(request.assetEdits ?? []), ...derived.edits]);
    // Prove every edited path is inside the asset tree and passes through no link, before the
    // proposal exists — a proposal nobody can apply is worse than a refusal nobody stored.
    // What each edited asset is *now*, so one edited on the host after this was reviewed refuses
    // instead of being silently overwritten by text composed against the older version. The
    // expectation travels with the write as well as being checked up front, because only the write
    // can check it without a gap.
    // The documents this change writes, AND the ones it was composed FROM. A private copy seeded from
    // a shared document is only correct while that document still says what it said at review time;
    // pinning only the destination would let an edit to the source land as a silently stale copy.
    const assetRevisions = [
      ...(await this.pinnedRevisions(assetEdits.map(edit => edit.path))),
      ...(await this.pinnedRevisions(derived.sources)),
    ];
    const expected = new Map(assetRevisions.map(asset => [asset.path, asset.revision]));
    const documents: FleetDocumentWrite[] = [];
    for (const edit of assetEdits) {
      documents.push({
        path: await this.assetStore.resolve(edit.path),
        content: edit.content,
        mode: ASSET_MODE,
        expect: expected.get(edit.path),
      });
    }
    const revision = await this.revision();
    const candidate = this.deriveCandidate(current, mutation);
    const plan = this.buildPlan(candidate);
    const preview = await this.previewFrom(plan);
    documents.unshift({
      path: this.configPath,
      content: Bun.YAML.stringify(candidate),
      mode: CONFIG_MODE,
      expect: revision,
    });
    return this.viewOf(
      this.proposals.open({
        revision,
        mutation: request.mutation,
        assetEdits,
        assetRevisions,
        // The exact artifact, built once. Apply consumes this rather than rebuilding, so the plan
        // that lands is the plan that was read — down to the timestamp in its manifest.
        payload: { kind: 'apply', plan, preview, documents },
        summary: summarize(request.mutation, candidate),
      }),
    );
  }

  /**
   * The text documents the mutation itself contributes, on top of whatever the caller composed.
   *
   * Only an unlink has any, and its one document is derived rather than accepted: the destination from
   * the account's own wrapper name, the content from the shared document as the host holds it now. A
   * caller able to supply either would have an arbitrary file write carrying a named intent's summary.
   *
   * An existing file at the destination is refused rather than overwritten. It is the account's own
   * previous copy, or somebody's work in progress, and either way replacing it with the shared text is
   * not what "give this account its own copy" was asked to do.
   */
  private async derivedAssetEdits(
    config: FleetConfig,
    mutation: Exclude<FleetMutation, { kind: 'initialize' }>,
  ): Promise<{ readonly edits: readonly FleetAssetEdit[]; readonly sources: readonly string[] }> {
    if (mutation.kind !== 'unlink-shared-asset') return { edits: [], sources: [] };
    const unlink = this.withMutationRefusals(() => planSharedAssetUnlink(config, mutation.accountId, mutation.field));
    if ((await this.assetRevision(unlink.destination)) !== ABSENT_ASSET_REVISION) {
      throw new FleetRefusal(
        'fleet_proposal_refused',
        `this fleet already has an asset at "${unlink.destination}"; point ${unlink.wrapper} at it with an account overlay rather than overwriting it with the shared text`,
      );
    }
    const shared = await this.withAssetRefusals(() => this.assetStore.read(unlink.source));
    return { edits: [{ path: unlink.destination, content: shared.content }], sources: [unlink.source] };
  }

  /** Turn a mutation's own refusal into the fleet's refusal grammar, so it is not a bare 500. */
  private withMutationRefusals<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof FleetMutationRefusal) throw new FleetRefusal('fleet_proposal_refused', error.message);
      throw error;
    }
  }

  /**
   * Which documents this fleet shares and who uses one, derived from the configuration.
   *
   * Derived rather than read from the last manifest, because the useful question is what the *next*
   * apply will materialize — so the report a person reads and the plan they approve come from one
   * document. Parsed on the way out through the shared schema like every other answer here.
   */
  async sharing(): Promise<FleetWireSharing> {
    return sharingSummary(resolveFleetSharing(await this.config()));
  }

  async readProposal(id: string): Promise<FleetProposalView> {
    return this.viewOf(this.requireProposal(id));
  }

  /** Everything a caller may see, derived from the stored artifact rather than stored twice. */
  private viewOf(record: FleetProposalRecord<FleetProposalPayload>): FleetProposalView {
    return redactProposal(record, payload =>
      payload.kind === 'initialize'
        ? { kind: 'initialize' as const, scaffold: scaffoldSummary(payload.scaffold), documents: [] }
        : {
            kind: 'apply' as const,
            plan: planSummary(payload.preview),
            // Named, because "review every write before it happens" has to include these ones.
            documents: payload.documents.map(document => ({
              path: document.path,
              bytes: new TextEncoder().encode(document.content).length,
            })),
          },
    );
  }

  /** What each of these assets is right now, so a change composed against an older one refuses. */
  private async pinnedRevisions(paths: readonly string[]): Promise<readonly FleetAssetRevision[]> {
    const revisions: FleetAssetRevision[] = [];
    for (const path of paths) revisions.push({ path, revision: await this.assetRevision(path) });
    return revisions;
  }

  /**
   * What an asset is right now, as a digest, or the sentinel when there is genuinely nothing there.
   *
   * Only a positively observed absence is "absent". A file that exists but cannot be read here — a
   * link, a binary, one past the size limit — is damage, and treating it as missing would let a
   * proposal that expected to create a file quietly overwrite one it simply could not open.
   */
  private async assetRevision(relative: string): Promise<string> {
    try {
      const document = await this.assetStore.read(relative);
      return new Bun.CryptoHasher('sha256').update(document.content).digest('hex');
    } catch (error) {
      if (error instanceof FleetAssetRefusal && error.missing) return ABSENT_ASSET_REVISION;
      if (error instanceof FleetAssetRefusal) throw new FleetRefusal('fleet_asset_refused', error.message);
      throw error;
    }
  }

  /**
   * Apply exactly the proposal that was reviewed.
   *
   * ## THE ORDER OF THE TWO STEPS IS THE SUBSTANCE
   *
   * The per-change confirmation is proved BEFORE the proposal is consumed, and the consume is then
   * synchronous. Reversed, a wrong password would burn a staged change the caller was entitled to
   * apply; interleaved with an await, two applies arriving together would both find it pending and
   * both run. So: confirm, then spend, then await.
   *
   * ## WHO MAY APPLY IS NOT DECIDED HERE
   *
   * The route declares `fleet`/`configure` and the authorization boundary has already enforced it —
   * including the operator's grant, the unlock, and the lockout. This adds ONE step for the caller
   * the boundary said owes it, and can never remove one. It used to decide the whole question itself
   * from `tokenClass`, which is the duplication `docs/design/fleet-authority-unification.md` was
   * written about.
   *
   * If the apply never reaches the host — a stale revision, a refused plan — the proposal is put
   * back, because consuming it was bookkeeping and nothing about the host changed.
   */
  async applyProposal(
    id: string,
    request: FleetProposalApplyRequest,
    governance: CallerGovernance | undefined,
  ): Promise<FleetApplyOutcome> {
    // Absent governance is refused rather than waved through. It cannot arise through the served
    // route — that route declares a capability, so the boundary always builds one — and the safe
    // reading of "nobody can tell me where this caller stands" is not "apply the change".
    if (governance === undefined) {
      throw new ApiError(403, 'this daemon cannot say whether this caller may change the fleet', 'forbidden');
    }
    // Read first, and NON-DESTRUCTIVELY. A change that timed out or was already applied is refused
    // as ITSELF rather than as a wrong password — and a wrong password against a dead change does
    // not spend one of the five tries the whole machine shares. It is a courtesy, not the check:
    // `consume` re-asks the same question, synchronously, which is what keeps single-use true when
    // two applies arrive together.
    this.withProposalRefusals(() => this.proposals.require(id));
    if (governance.confirmChange) await this.confirm(id, request.operatorPassword);
    const record = this.withProposalRefusals(() => this.proposals.consume(id));

    // Reopening the change is only safe while it is certain nothing was attempted. That certainty
    // ends the instant materialization begins: from there a failure may have left the host part-way
    // and rolled back, part-way and not, or committed with a later step failing — and a proposal
    // handed back as "still applicable" would invite a second apply on top of an unknown state.
    // So the two phases have separate boundaries rather than one shared catch.
    try {
      await this.assertCurrent(record);
    } catch (error) {
      if (error instanceof FleetRefusal) this.proposals.restore(record);
      throw error;
    }

    return await this.materialize(record);
  }

  /**
   * Prove the operator password against THIS change, or refuse in words naming the next step.
   *
   * The proposal id is in every sentence on purpose: this is a confirmation of one exact staged
   * artifact, and a refusal that did not name which one would read as a login failure. Nothing here
   * receives, returns or logs the password — it goes to the injected port and what comes back is a
   * reason, which is the same use-never-read shape the secret store is built on.
   */
  private async confirm(id: string, password: string | undefined): Promise<void> {
    if (password === undefined) {
      throw new FleetRefusal(
        'fleet_proposal_unauthorized',
        `applying fleet change "${id}" from off this host needs this machine's operator password, entered against this exact change`,
      );
    }
    const outcome = await this.options.confirmChange(password);
    if (outcome.kind === 'confirmed') return;
    if (outcome.reason === 'rate-limited') {
      throw new FleetRefusal(
        'fleet_proposal_unauthorized',
        `too many wrong operator passwords have been tried on this machine, so it is not checking any more of them for now; fleet change "${id}" was not applied. Wait for the lockout to pass, or clear it on the host with \`${this.options.clientName} daemon password set\`.`,
      );
    }
    // A password that vanished between the boundary reading `passwordSet` and this check is a real
    // race — `fy daemon password clear` runs while a change is staged — and it is reported as
    // itself rather than as a wrong password, because "you typed it wrong" would send somebody
    // hunting for a secret this machine no longer has.
    if (outcome.reason === 'no-password') {
      throw new FleetRefusal(
        'fleet_proposal_unauthorized',
        `this machine's operator password was removed while fleet change "${id}" was being applied, so the confirmation could not be checked; review the change again`,
      );
    }
    throw new FleetRefusal(
      'fleet_proposal_unauthorized',
      `that is not this machine's operator password, so fleet change "${id}" was not applied and is still open`,
    );
  }

  /**
   * Refuse a change whose inputs have moved since it was reviewed.
   *
   * Both halves matter. The configuration is the obvious one; the assets are the one that loses
   * data quietly, because the stored text was composed against a version of the file that no longer
   * exists and writing it would silently discard whatever replaced it.
   */
  private async assertCurrent(record: FleetProposalRecord<FleetProposalPayload>): Promise<void> {
    if ((await this.revision()) !== record.revision) {
      throw new FleetRefusal(
        'fleet_proposal_stale',
        'the fleet configuration changed on this host after this change was previewed; review it again',
      );
    }
    for (const asset of record.assetRevisions) {
      if ((await this.assetRevision(asset.path)) === asset.revision) continue;
      throw new FleetRefusal(
        'fleet_proposal_stale',
        `the asset "${asset.path}" changed on this host after this change was previewed; review it again`,
      );
    }
  }

  /** Turn one held proposal into host state, inside a single rollback boundary. */
  private async materialize(record: FleetProposalRecord<FleetProposalPayload>): Promise<FleetApplyOutcome> {
    const payload = record.payload;
    if (payload.kind === 'initialize') {
      // The exact scaffold that was reviewed, including the identifiers in its example — rebuilding
      // it would mint different ones, so the host would not receive what the preview described.
      // Create-if-absent is the kernel's decision, so this can only ever add what is missing.
      return await this.prepareHost(payload.scaffold);
    }

    try {
      return {
        outcome: 'committed',
        result: applyResultSummary(await this.provisioner.apply(payload.plan, payload.documents)),
      };
    } catch (error) {
      if (!(error instanceof FleetApplyFailureError)) {
        throw new FleetRefusal('fleet_apply_refused', errorMessage(error));
      }
      return applyOutcomeOf(error);
    }
  }

  /**
   * Write the exact scaffold that was reviewed, serialized against ordinary fleet applies.
   *
   * The scaffolder creates only what is absent, one file at a time, and it can throw part-way. That
   * is a genuinely partial host — some starter files present, some not — and it is reported as one
   * rather than as an untouched host. It is safe to re-run: the second attempt creates the
   * remainder and keeps everything already there, because absence is the kernel's decision.
   */
  private async prepareHost(scaffold: FleetScaffold): Promise<FleetApplyOutcome> {
    const lock = fleetApplyLockFor(this.layout.manifestPath);
    const token = await lock.acquire();
    try {
      const result = await this.scaffolder.scaffold(scaffold);
      const residue = await lock.release(token);
      return {
        outcome: 'initialized',
        created: [...result.created],
        kept: [...result.kept],
        directories: [...result.directories],
        pathEntry: result.pathEntry,
        ...(residue === undefined ? {} : { lockResidue: residue }),
      };
    } catch (error) {
      const residue = await lock.release(token);
      if (error instanceof FleetScaffoldPartialError) {
        return {
          outcome: 'initialization-partial',
          reason: errorMessage(error.cause),
          failedPath: error.failedPath,
          created: [...error.progress.created],
          kept: [...error.progress.kept],
          directories: [...error.progress.directories],
          ...(residue === undefined ? {} : { lockResidue: residue }),
        };
      }
      // Residue travels with every ending, including the ones that are not outcomes. A failure the
      // scaffolder did not classify says nothing about the host, but a claim this attempt could not
      // clear still blocks the next apply — so it is named in the refusal rather than dropped on
      // the way out, which would leave a fleet that silently refuses to change and no account of why.
      if (residue === undefined) throw error;
      throw new FleetRefusal(
        'fleet_apply_refused',
        `${errorMessage(error)}; the exclusive apply claim at ${residue} could not be cleared`,
      );
    }
  }

  private scaffold(): FleetScaffold {
    return buildFleetScaffold({
      layout: this.layout,
      ids: { claude: this.options.mintUuid(), codex: this.options.mintUuid() },
      configPath: this.configPath,
    });
  }

  private deriveCandidate(config: FleetConfig, mutation: FleetMutation): FleetConfig {
    try {
      return applyFleetMutation(config, mutation, () => this.options.mintUuid());
    } catch (error) {
      if (error instanceof FleetMutationRefusal) throw new FleetRefusal('fleet_proposal_refused', error.message);
      throw error;
    }
  }

  private buildPlan(config: FleetConfig): FleetApplyPlan {
    try {
      return this.planner.build(config, this.layout, this.generatedAt());
    } catch (error) {
      throw new FleetRefusal('fleet_plan_refused', errorMessage(error));
    }
  }

  private async previewFrom(plan: FleetApplyPlan): Promise<FleetApplyPreview> {
    try {
      return await this.provisioner.preview(plan);
    } catch (error) {
      throw new FleetRefusal('fleet_plan_refused', errorMessage(error));
    }
  }

  /**
   * A digest of the configuration as it is on disk, or the sentinel for a host that has none.
   *
   * Hashing the raw bytes rather than the parsed value is deliberate: an operator's hand edit that
   * re-parses to the same configuration still changed the file they own, and a change they made
   * between reviewing and applying is exactly what this is for.
   */
  private async revision(): Promise<string> {
    try {
      const raw = await readFile(this.configPath);
      return new Bun.CryptoHasher('sha256').update(raw).digest('hex');
    } catch (error) {
      if (missingFile(error)) return MISSING_CONFIG_REVISION;
      throw new FleetRefusal('fleet_config_invalid', `fleet config at ${this.configPath} is unreadable`);
    }
  }

  private requireProposal(id: string): FleetProposalRecord<FleetProposalPayload> {
    return this.withProposalRefusals(() => this.proposals.require(id));
  }

  private withProposalRefusals<T>(work: () => T): T {
    try {
      const produced = work();
      // An async caller's refusal arrives as a rejection, so the same translation has to reach it.
      if (produced instanceof Promise) return produced.catch(error => this.translate(error)) as T;
      return produced;
    } catch (error) {
      return this.translate(error);
    }
  }

  private translate(error: unknown): never {
    if (error instanceof FleetProposalRefusal) throw new FleetRefusal(PROPOSAL_CODES[error.problem], error.message);
    if (error instanceof FleetAssetRefusal) throw new FleetRefusal('fleet_asset_refused', error.message);
    throw error;
  }

  async accounts(): Promise<FleetManifest> {
    return await this.loadManifest();
  }

  /**
   * Pass-through on purpose. Every decision — what counts as detected, what a fallback says about
   * itself, which absence gets which sentence — belongs to the discovery module, which is provable
   * without a filesystem. A mount that re-derived any of it would be a second answer to the same
   * question, and the two would drift the first time either moved.
   */
  async harnesses(): Promise<HarnessDiscoveryReport> {
    return await this.options.harnesses.report();
  }

  async config(): Promise<FleetConfig> {
    try {
      await readFile(this.configPath);
    } catch (error) {
      if (missingFile(error)) {
        throw new FleetRefusal(
          'fleet_config_missing',
          `no fleet config at ${this.configPath}; write the declared config before applying the fleet`,
        );
      }
      throw new FleetRefusal('fleet_config_invalid', `fleet config at ${this.configPath} is unreadable`);
    }

    try {
      return await this.configSource.load();
    } catch (error) {
      throw new FleetRefusal('fleet_config_invalid', errorMessage(error));
    }
  }

  async environment(): Promise<FleetEnvironmentView> {
    const config = await this.config();
    const profiles: Record<string, Record<string, string>> = {};
    for (const [name, profile] of Object.entries(config.profiles)) {
      profiles[name] = portableEnvironment(profile.env ?? {}, name);
    }
    return { profiles };
  }

  async updateEnvironment(request: FleetEnvironmentUpdate): Promise<FleetEnvironmentView> {
    const current = await this.config();
    const profile = current.profiles[request.profile];
    if (profile === undefined)
      throw new FleetRefusal('fleet_environment_refused', `profile ${request.profile} does not exist on this daemon`);
    const existing = portableEnvironment(profile.env ?? {}, request.profile);
    const incoming = portableEnvironment(request.environment, request.profile);
    const environment = request.mode === 'merge' ? { ...existing, ...incoming } : incoming;
    const next = FleetConfigSchema.parse({
      ...current,
      profiles: { ...current.profiles, [request.profile]: { ...profile, env: environment } },
    });
    // The state filesystem writes a new, synced file then renames it into place. A failed write
    // therefore leaves the last validated fleet configuration intact rather than half-replacing it.
    await this.options.files.writeTextAtomic(this.configPath, Bun.YAML.stringify(next));
    return await this.environment();
  }

  async plan(): Promise<FleetApplyPreview> {
    const config = await this.config();
    try {
      const plan: FleetApplyPlan = this.planner.build(config, this.layout, this.generatedAt());
      return await this.provisioner.preview(plan);
    } catch (error) {
      throw new FleetRefusal('fleet_plan_refused', errorMessage(error));
    }
  }

  /**
   * Quota, collected through the same factory and the same probe the CLI uses.
   *
   * Built per request rather than once at mount, because the thresholds, the concurrency and the
   * per-credential grouping are all configuration: a collector assembled before the configuration was
   * read could only ever use the defaults. Two call sites each assembling their own is how this route
   * and `fy fleet usage` would come to disagree about whether an account has quota left.
   */
  async usage(): Promise<FleetUsageSnapshot> {
    const [config, manifest] = [await this.config(), await this.loadManifest()];
    return await buildFleetUsageCollector(
      config,
      this.options.usageProbe ?? this.probe(config.usage.timeout),
      this.options.clock,
    ).collect(manifest);
  }

  async health(): Promise<FleetHealthSnapshot> {
    const [config, manifest] = [await this.config(), await this.loadManifest()];
    return await buildFleetHealthCollector(
      config,
      this.options.healthProbe ?? this.healthProbe(),
      this.options.clock,
    ).collect(manifest);
  }

  /**
   * This host's provider probe. Shared with the CLI so neither can drift from the other.
   *
   * The declared `usage.timeout` is passed IN, because it reached neither composition root: the probe
   * landed after the plan-time refusal list was written, so a configuration that bounded its provider
   * calls was parsed and silently dropped, and every probe ran on the adapter's own default instead.
   * That matters more now than it did — the daemon's whole quota feed collects through here, so one
   * hung provider call stalls the refresh every session, the advisor and every scraper is waiting on.
   */
  private probe(timeoutSeconds: number): FleetUsageProbe {
    return new AnthropicUsageProbe({
      fetch: fetchQuota,
      timeoutMs: timeoutSeconds * 1_000,
      credentials: new PlatformFleetCredentialStore({
        platform: this.options.platform,
        command: new SpawnCredentialCommand(),
        now: () => this.options.clock.now(),
        keychainAccount: this.options.keychainAccount ?? '',
      }),
    });
  }

  private healthProbe(): FleetHealthProbe {
    return new ProcessFleetHealthProbe({
      process: runFleetHealthProcess,
      // This is under the mounted daemon's state home: one daemon cannot reuse another's success.
      cachePath: join(this.options.paths.fleet, 'health-successes.json'),
      now: () => this.options.clock.now(),
    });
  }

  async apply(): Promise<FleetApplyResult> {
    const plan = await this.plan();
    try {
      return await this.provisioner.apply(plan);
    } catch (error) {
      throw new FleetRefusal('fleet_apply_refused', errorMessage(error));
    }
  }

  private generatedAt(): string {
    const now = this.options.clock.now();
    if (!Number.isFinite(now)) throw new Error('the fleet clock did not return a finite instant');
    return new Date(Math.trunc(now)).toISOString();
  }

  private async loadManifest(): Promise<FleetManifest> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.options.paths.fleetManifest, 'utf8'));
    } catch (error) {
      if (missingFile(error)) {
        throw new FleetRefusal(
          'fleet_not_applied',
          `no published fleet manifest at ${this.options.paths.fleetManifest}; apply the fleet first`,
        );
      }
      throw new FleetRefusal(
        'fleet_manifest_invalid',
        `fleet manifest at ${this.options.paths.fleetManifest} is unreadable or invalid`,
      );
    }
    const parsed = FleetManifestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new FleetRefusal(
        'fleet_manifest_invalid',
        `fleet manifest at ${this.options.paths.fleetManifest} is invalid`,
      );
    }
    return parsed.data;
  }
}

/** Build the production subsystem against exactly one daemon's FoundationPaths/FY_HOME. */
export function createDaemonFleetSubsystem(options: DaemonFleetOptions): FleetSubsystem {
  return new MountedFleet(options);
}

async function respond(work: () => Promise<unknown>) {
  try {
    return jsonResponse(await work());
  } catch (error) {
    if (error instanceof FleetRefusal) throw new ApiError(409, error.message, error.code);
    throw error;
  }
}

/**
 * Answer with a value proven against the contract three consumers read.
 *
 * A shared schema that is only a type alias proves nothing at runtime: the daemon could add a
 * field, drop one, or answer with a shape the browser cannot render, and nothing would say so until
 * a client fell over. Parsing on the way out makes this side the one that fails, loudly, at the
 * boundary where the contract is stated.
 */
async function respondWith<Schema extends z.ZodType>(schema: Schema, work: () => Promise<unknown>) {
  return await respond(async () => schema.parse(await work()));
}

/**
 * All reads are admin because config, plans and manifests disclose homes, wrappers and settings.
 * Apply is also declared admin, then rejects a paired-device credential explicitly: a browser may
 * inspect its paired daemon, but possession of a device token can never provision the host.
 */
export function fleetRoutes(subsystem: FleetSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/fleet/accounts',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      // Held to the same shared contract the preview's manifest is, so the roster a client compares
      // a proposal against and the roster inside that proposal are described by one schema.
      handle: async () =>
        await respondWith(FleetManifestSummarySchema, async () => manifestSummary(await subsystem.accounts())),
    },
    {
      /**
       * What this host has, as opposed to what this fleet publishes.
       *
       * `fleet`/`use` like every other read here, and for the same reason: the answer names absolute
       * paths in somebody's home and the text of their instructions document, which is the same class
       * of disclosure as a wrapper path or a settings layer. It is a READ — nothing is launched, and
       * nothing on the host changes — so it sits beside `accounts` rather than behind `configure`.
       */
      method: 'GET',
      path: '/v1/fleet/harnesses',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => await respondWith(HarnessDiscoveryReportSchema, () => subsystem.harnesses()),
    },
    {
      method: 'GET',
      path: '/v1/fleet/config',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => await respond(() => subsystem.config()),
    },
    {
      method: 'GET',
      path: '/v1/fleet/environment',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => await respond(() => subsystem.environment()),
    },
    {
      method: 'PUT',
      path: '/v1/fleet/environment',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      // The `configure` declaration IS the refusal now. This handler used to re-decide it with an
      // inline `tokenClass === 'device'` 403 — invisible to the route table and to `GrantsView`, so
      // no surface could explain it before somebody clicked, which `docs/design/one-fact-one-owner.md`
      // names as the smell in its purest form.
      handle: async context =>
        await respond(
          async () => await subsystem.updateEnvironment(await parseBody(context.request, FleetEnvironmentUpdateSchema)),
        ),
    },
    {
      method: 'GET',
      path: '/v1/fleet/plan',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => await respond(() => subsystem.plan()),
    },
    {
      method: 'GET',
      path: '/v1/fleet/usage',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => await respond(() => subsystem.usage()),
    },
    {
      method: 'GET',
      path: '/v1/fleet/health',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => await respond(() => subsystem.health()),
    },
    {
      method: 'POST',
      path: '/v1/fleet/apply',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      // No inline class check, for the same reason as `PUT /v1/fleet/environment` above. This route
      // stays unreached from the browser (`route-agreement-allowlist.txt`) — the panel always goes
      // through a staged proposal so a person reviews every write first — and that is a property of
      // the surface, not an authority this handler enforces.
      handle: async () => await respond(() => subsystem.apply()),
    },
    {
      method: 'GET',
      path: '/v1/fleet/permissions',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async context =>
        await respondWith(FleetPermissionsSchema, async () => subsystem.permissions(context.governance)),
    },
    {
      /**
       * Which documents this fleet shares and who uses one.
       *
       * A read of its own rather than a field on the account roster: the roster is what the last apply
       * published, and this is derived from the configuration as it stands now. Folding one into the
       * other would give a single response two different notions of "current".
       */
      method: 'GET',
      path: '/v1/fleet/sharing',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => await respondWith(FleetSharingSchema, () => subsystem.sharing()),
    },
    {
      method: 'GET',
      path: '/v1/fleet/assets',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => await respondWith(FleetAssetIndexSchema, () => subsystem.assets()),
    },
    {
      method: 'GET',
      path: '/v1/fleet/assets/:assetPath',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async context =>
        await respondWith(FleetAssetDocumentSchema, () =>
          subsystem.asset(decodeParameter(context.params.get('assetPath') ?? '') ?? ''),
        ),
    },
    {
      /**
       * The one route here whose purpose is to carry bulk caller-supplied text.
       *
       * Every bound the asset edits state — 32 files, 64 KiB each, 256 KiB together — is enforced
       * by a schema, and a schema reads a string the transport has already materialised. So the
       * read itself is bounded first, at the text ceiling rather than the attachment one: a cap
       * applied in a handler is a cap applied after the allocation it was meant to prevent.
       */
      method: 'POST',
      path: '/v1/fleet/proposals',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async context =>
        await respondWith(
          FleetProposalViewSchema,
          async () =>
            await subsystem.propose(
              await parseBody(context.request, FleetProposalRequestSchema, { maxBytes: MAX_TEXT_BODY_BYTES }),
            ),
        ),
    },
    {
      method: 'GET',
      path: '/v1/fleet/proposals/:proposalId',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async context =>
        await respondWith(FleetProposalViewSchema, () =>
          subsystem.readProposal(decodeParameter(context.params.get('proposalId') ?? '') ?? ''),
        ),
    },
    {
      /**
       * Apply one held proposal.
       *
       * `fleet`/`configure`, and that declaration is the whole of who may reach it. A route
       * `POST /v1/fleet/proposals/:proposalId/authorize` used to sit above this one, minting a
       * single-use code a person transcribed off the host's own terminal; it was a second authority
       * system with its own lifetime, its own attempt budget and its own refusal vocabulary, and it
       * is deleted along with the `fy fleet authorize` verb that dialled it — in this same change,
       * because `route-agreement-allowlist.txt` may only shrink and a half-deletion has no line it
       * is permitted to record.
       *
       * What replaced it is not a credential: a governed caller confirms the change with the
       * operator password, in this request, against this one proposal.
       */
      method: 'POST',
      path: '/v1/fleet/proposals/:proposalId/apply',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      handle: async context => {
        const body = (await parseOptionalBody(context.request, FleetProposalApplyRequestSchema)) ?? {};
        return await respondWith(FleetApplyOutcomeSchema, () =>
          subsystem.applyProposal(
            decodeParameter(context.params.get('proposalId') ?? '') ?? '',
            body,
            context.governance,
          ),
        );
      },
    },
  ];
}
