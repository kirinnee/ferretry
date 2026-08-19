/**
 * The provisioning boundary: what `fy fleet apply` decides, and what it asks an adapter to do.
 *
 * A plan is a complete, inspectable description of every write. Deciding and writing are separate
 * so the decision half stays pure — the plan for a configuration is a value a test can assert on,
 * with no filesystem in sight — and so `--dry-run` is the same code path minus the last step.
 */
import type { FleetConfig } from './config.ts';
import type { FleetManifest, HarnessKind } from './manifest.ts';
import type { SettingsFormat, SettingsObject } from './settings.ts';
import type { SharedHistoryPreview, SharedHistoryRequest } from './shared-history.ts';

/** Every directory the fleet owns. Supplied by the composition root, never discovered. */
export interface FleetLayout {
  /** Root of the Ferretry state home (`FY_HOME`). */
  readonly stateHome: string;
  /** The user's home directory, used to expand `~/` in configured paths. */
  readonly userHome: string;
  readonly fleetDirectory: string;
  /** Generated wrappers land here; this directory goes on `PATH`. */
  readonly binDirectory: string;
  /** Default parent for account homes declared as a relative path. */
  readonly homesDirectory: string;
  /** Default parent for profile assets referenced by a relative path. */
  readonly assetsDirectory: string;
  readonly manifestPath: string;
  /** Where the bare upstream CLI of each harness reads its configuration from. */
  readonly defaultHomeDirectories: Readonly<Record<HarnessKind, string>>;
}

/**
 * One write. `settings` carries unresolved layers because reading a referenced file is IO; the
 * adapter resolves them and merges with the rules in `settings.ts`. Two operations remove things
 * rather than write them — `prune` and `prune-directory` — and each states its own bound where it is
 * declared, because they sweep destinations the fleet owns to different degrees.
 */
export type FleetWriteOperation =
  | {
      readonly kind: 'directory';
      readonly path: string;
      readonly mode?: number;
    }
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly content: string;
      readonly mode: number;
    }
  | {
      readonly kind: 'copy';
      readonly source: string;
      readonly path: string;
      readonly mode?: number;
    }
  | {
      readonly kind: 'symlink';
      readonly source: string;
      readonly path: string;
    }
  | {
      readonly kind: 'settings';
      readonly path: string;
      readonly format: SettingsFormat;
      readonly layers: readonly SettingsLayerSource[];
      readonly mode: number;
      /**
       * Fold the file already at `path` in as the base layer. The harness writes its own keys there
       * at runtime (`/effort`), and a re-apply that clobbered them would silently reset the user.
       */
      readonly preserveExisting: boolean;
    }
  | {
      /**
       * Maintain Ferretry's ownership sidecar for Codex's `sqlite_home` override. The following
       * `settings` operation writes the actual value when enabled; this operation captures the
       * original first, or restores it on disable only when the current value is still ours.
       */
      readonly kind: 'codex-sqlite-ownership';
      /** Codex `config.toml`; also the bounded path reported by dry-run. */
      readonly path: string;
      readonly markerPath: string;
      readonly sqliteHome: string;
      readonly enabled: boolean;
    }
  | {
      readonly kind: 'prune';
      /** Directory to sweep. Only its direct children are considered. */
      readonly path: string;
      /** Marker a file must contain before it may be removed. */
      readonly marker: string;
      /** Names to keep, whether or not they carry the marker. */
      readonly keep: readonly string[];
    }
  | {
      /**
       * Remove every direct child of a directory this plan materialized entry by entry.
       *
       * The second destructive operation, and bounded differently from `prune` because what it sweeps
       * is different. `prune` sweeps a directory Ferretry shares with the user's own `PATH` files, so
       * it may only remove files carrying the managed marker. This sweeps a destination the fleet owns
       * outright: an account's skills directory was REPLACED wholesale on every apply before the field
       * became per-item, so every direct child of it is this plan's own work from an earlier run. The
       * keep list is the bound, and it is exactly the selection.
       *
       * Without it, per-item selection would be write-only: deselecting a skill would leave the
       * account still holding — and still able to run — the item it was just told to give up.
       */
      readonly kind: 'prune-directory';
      /** Directory to sweep. Only its direct children are considered. */
      readonly path: string;
      /** Names this plan materialized. Every other direct child is removed, file or directory. */
      readonly keep: readonly string[];
    };

/** A settings layer as the plan sees it: a file still to be read, or an object already known. */
export type SettingsLayerSource =
  | { readonly from: 'file'; readonly path: string }
  | { readonly from: 'inline'; readonly settings: SettingsObject };

export interface FleetApplyPlan {
  readonly manifest: FleetManifest;
  readonly manifestPath: string;
  readonly operations: readonly FleetWriteOperation[];
  /** Filesystem-observed separately so dry-run can report exact moves and collision winners. */
  readonly sharedHistoryRequests?: readonly SharedHistoryRequest[];
}

/** A plan plus the exact read-only history migration evidence observed for this invocation. */
export interface FleetApplyPreview extends FleetApplyPlan {
  readonly sharedHistory: readonly SharedHistoryPreview[];
}

export interface FleetPlanBuilder {
  build(config: FleetConfig, layout: FleetLayout, generatedAt: string): FleetApplyPlan;
}

/**
 * A text document written inside the same rollback boundary as the plan's own operations.
 *
 * A configuration edit and the assets it references are only meaningfully atomic *together* with
 * the fleet they describe: a host left declaring an account whose home was never materialized is
 * exactly the half-state an all-or-nothing apply exists to prevent.
 */
export interface FleetDocumentWrite {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
  /**
   * The digest this write expects to find already at `path`, or `ABSENT_DOCUMENT_REVISION` when it
   * expects nothing there.
   *
   * Checked *after* the existing entry has been captured, which is the only point at which the
   * answer cannot go stale: capture renames the entry away atomically, so nothing else can reach
   * the path afterwards and what was moved aside is exactly what the check is about. A check made
   * before the capture leaves a window in which the host is edited and the edit is then silently
   * overwritten by text composed against the older version.
   */
  readonly expect?: string;
}

/** The expected-digest value meaning "nothing should be here yet". */
export const ABSENT_DOCUMENT_REVISION = 'absent';

export interface FleetProvisioner {
  preview(plan: FleetApplyPlan): Promise<FleetApplyPreview>;
  apply(plan: FleetApplyPlan, documents?: readonly FleetDocumentWrite[]): Promise<FleetApplyResult>;
}

/**
 * State a rollback moved out of the way rather than deleting.
 *
 * A rollback only ever renames; it never deletes anything it cannot prove it wrote. When what sat
 * at a destination turned out not to be this apply's own work, it is kept under a reserved name and
 * reported here, because it is somebody's data and only they can decide what it is worth.
 */
export interface DisplacedState {
  /** Where it was. */
  readonly path: string;
  /** Where it is now. */
  readonly movedTo: string;
}

/** A path whose prior state could not be put back, and the reason it could not. */
export interface UnrestoredPath {
  readonly path: string;
  readonly reason: string;
  /**
   * Where the original still is, when it was moved aside and could not be moved back. Reported
   * because it is the only remaining copy: a caller that cleaned it up would destroy the evidence
   * a person needs to finish the restoration by hand.
   */
  readonly backup?: string;
}

/** What a host actually carries once ordinary provisioning has committed its manifest. */
export interface FleetApplyCommittedState {
  readonly accountCount: number;
  readonly operationCount: number;
  readonly manifestPath: string;
  readonly manifest: FleetManifest;
  readonly prunedWrappers: readonly string[];
  /** Migrations that completed before the failure. */
  readonly sharedHistory: readonly SharedHistoryPreview[];
  /** Moved-aside evidence left on disk by the committed apply. */
  readonly backupResidue?: readonly string[];
  /**
   * The exclusive claim this apply could not verify releasing. Residue, never a failure — but it
   * blocks the next apply until it is cleared, so it is named rather than swallowed.
   */
  readonly lockResidue?: string;
}

/**
 * Why an apply did not succeed, in the only three shapes that differ for the person reading it.
 *
 * The distinction that matters is not which write threw but **what the host is now**: back where it
 * started, somewhere that could not be verified, or genuinely changed with a later step failing.
 * Collapsing these into one "apply failed" is how a fleet that did land gets re-applied blindly.
 */
export type FleetApplyFailure =
  | {
      /**
       * Nothing was committed and the host is exactly as it was: every captured entry verified
       * back, and nothing of anyone else's moved. Both conditions, because a rollback that had to
       * set somebody's file aside left the host with a path renamed and a reserved file present —
       * true of the fleet, but not true of the host, and this is the state a reader acts on.
       */
      readonly kind: 'rolled-back';
      readonly failedOperation: string;
      readonly reason: string;
    }
  | {
      /** Restoration could not be verified, or something not ours had to be moved out of the way. */
      readonly kind: 'rollback-incomplete';
      readonly failedOperation: string;
      readonly reason: string;
      readonly unrestored: readonly UnrestoredPath[];
      readonly displaced?: readonly DisplacedState[];
    }
  | {
      /**
       * Ordinary provisioning committed, including the manifest. History migration has its own
       * boundary and did not roll the fleet back — so the committed state is reported exactly.
       */
      readonly kind: 'history-failed-after-commit';
      readonly failedHarness: HarnessKind;
      readonly reason: string;
      readonly committed: FleetApplyCommittedState;
    };

function describeFailure(failure: FleetApplyFailure): string {
  if (failure.kind === 'rolled-back') {
    return `apply failed at ${failure.failedOperation}: ${failure.reason} — the host was restored to its previous state and nothing was committed`;
  }
  if (failure.kind === 'rollback-incomplete') {
    const parts: string[] = [];
    if (failure.unrestored.length > 0) {
      parts.push(
        `restoration could not be verified for: ${failure.unrestored.map(entry => `${entry.path} (${entry.reason})`).join('; ')}`,
      );
    }
    const displaced = failure.displaced ?? [];
    if (displaced.length > 0) {
      parts.push(
        `content that was not this apply's was moved aside: ${displaced.map(entry => `${entry.path} → ${entry.movedTo}`).join('; ')}`,
      );
    }
    return `apply failed at ${failure.failedOperation}: ${failure.reason} — ${parts.join('; and ')}`;
  }
  return `the fleet was applied and its manifest published at ${failure.committed.manifestPath}, but ${failure.failedHarness} shared history failed afterwards: ${failure.reason}`;
}

/**
 * A failed apply, carrying the exact post-state rather than only a message. The message repeats the
 * structured evidence so a caller that only logs it still says something true.
 */
export class FleetApplyFailureError extends Error {
  constructor(
    readonly failure: FleetApplyFailure,
    /** An exclusive claim whose release could not be verified. Never changes the classification. */
    readonly lockResidue?: string,
  ) {
    super(
      lockResidue === undefined
        ? describeFailure(failure)
        : `${describeFailure(failure)}; the exclusive apply claim at ${lockResidue} could not be cleared`,
    );
    this.name = 'FleetApplyFailureError';
  }
}

export interface FleetApplyResult {
  readonly accountCount: number;
  readonly operationCount: number;
  readonly manifestPath: string;
  /** Managed wrappers removed because no account or command claims them any more. */
  readonly prunedWrappers: readonly string[];
  /** Exact moves, links, merges and preserved collisions completed for each enabled harness. */
  readonly sharedHistory: readonly SharedHistoryPreview[];
  /**
   * Moved-aside evidence left on disk after a successful apply. Residue, never a failure: undoing a
   * committed apply to tidy up would delete the very state the manifest now describes.
   */
  readonly backupResidue?: readonly string[];
  /**
   * The exclusive claim this apply could not verify releasing. Residue, never a failure — reporting
   * it as one would turn a fleet that fully landed into a fleet the caller believes was refused —
   * but it blocks the next apply until it is cleared, so it is named rather than swallowed.
   */
  readonly lockResidue?: string;
}

export class FleetApplyService {
  constructor(
    private readonly plans: FleetPlanBuilder,
    private readonly provisioner: FleetProvisioner,
  ) {}

  async apply(config: FleetConfig, layout: FleetLayout, generatedAt: string): Promise<FleetApplyResult> {
    const plan = this.plans.build(config, layout, generatedAt);
    return await this.provisioner.apply(plan);
  }

  async preview(config: FleetConfig, layout: FleetLayout, generatedAt: string): Promise<FleetApplyPreview> {
    const plan = this.plans.build(config, layout, generatedAt);
    return await this.provisioner.preview(plan);
  }
}
