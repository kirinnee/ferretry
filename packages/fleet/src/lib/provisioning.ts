/**
 * The provisioning boundary: what `fy fleet apply` decides, and what it asks an adapter to do.
 *
 * A plan is a complete, inspectable description of every write. Deciding and writing are separate
 * so the decision half stays pure — the plan for a configuration is a value a test can assert on,
 * with no filesystem in sight — and so `--dry-run` is the same code path minus the last step.
 */
import type { FleetConfig } from './config.ts';
import type { HarnessKind } from './manifest.ts';
import type { FleetManifest } from './manifest.ts';
import type { SettingsFormat, SettingsObject } from './settings.ts';

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
 * adapter resolves them and merges with the rules in `settings.ts`. `prune` is the only destructive
 * operation, and it is bounded twice: to one directory, and to files carrying the managed marker.
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
      readonly kind: 'prune';
      /** Directory to sweep. Only its direct children are considered. */
      readonly path: string;
      /** Marker a file must contain before it may be removed. */
      readonly marker: string;
      /** Names to keep, whether or not they carry the marker. */
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
}

export interface FleetPlanBuilder {
  build(config: FleetConfig, layout: FleetLayout, generatedAt: string): FleetApplyPlan;
}

export interface FleetProvisioner {
  apply(plan: FleetApplyPlan): Promise<FleetApplyResult>;
}

export interface FleetApplyResult {
  readonly accountCount: number;
  readonly operationCount: number;
  readonly manifestPath: string;
  /** Managed wrappers removed because no account or command claims them any more. */
  readonly prunedWrappers: readonly string[];
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
}
