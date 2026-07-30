import type { FleetConfig } from './config.ts';
import type { FleetManifest } from './manifest.ts';

export interface FleetLayout {
  readonly stateHome: string;
  readonly userHome: string;
  readonly fleetDirectory: string;
  readonly binDirectory: string;
  readonly homesDirectory: string;
  readonly manifestPath: string;
}

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
    };

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
