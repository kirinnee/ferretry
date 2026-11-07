import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type AccountChange,
  type AccountChangeOutcome,
  AccountChangeOutcomeSchema,
  AccountChangeRequestSchema,
  type AccountChangeView,
  AccountChangeViewSchema,
  type CloneBundle,
  CloneBundleSchema,
  CloneForgetRequestSchema,
  CloneForgetResultSchema,
  type CloneReview,
  type CloneReviewRequest,
  CloneReviewRequestSchema,
  CloneReviewSchema,
  type MachineView,
  MachineViewSchema,
  ProposalApplyRequestSchema,
  type SetupScan,
  SetupScanSchema,
  type ToolInstallResult,
  ToolInstallRequestSchema,
  ToolInstallResultSchema,
} from '@ferretry/plugin-runtimes/contract';
import type { IMachineGateway, MachineHarness } from './ports.ts';

/** The route keys the Runtimes manifest declares; a typo here is a refused call, not a 404 at run time. */
export const MACHINE_ROUTES = {
  machine: 'GET /v1/runtimes/machine',
  propose: 'POST /v1/runtimes/proposals',
  apply: 'POST /v1/runtimes/proposals/:proposalId/apply',
  scan: 'GET /v1/runtimes/setup/scan',
  installTools: 'POST /v1/runtimes/machine/tools/install',
  exportBundle: 'GET /v1/runtimes/export',
  reviewClone: 'POST /v1/runtimes/clone/review',
  forgetClone: 'POST /v1/runtimes/clone/forget',
} as const;

/**
 * Speaks the Runtimes routes through the guarded client of the invocation, parsing every answer through the shared
 * schema, which has no field a login could occupy. THIS CLASS HOLDS NO AUTHORITY: the daemon governs a caller by how
 * it arrived, and a write is confirmed by the daemon's own preview-then-apply, never by anything carried here.
 */
export class ClientMachineGateway implements IMachineGateway {
  constructor(private readonly client: Pick<PluginClient, 'call'>) {}

  async machine(): Promise<MachineView> {
    return MachineViewSchema.parse(await this.client.call(MACHINE_ROUTES.machine));
  }

  async stage(change: AccountChange): Promise<AccountChangeView> {
    const body = AccountChangeRequestSchema.parse({ change });
    return AccountChangeViewSchema.parse(await this.client.call(MACHINE_ROUTES.propose, { body }));
  }

  async apply(changeId: string): Promise<AccountChangeOutcome> {
    const body = ProposalApplyRequestSchema.parse({});
    return AccountChangeOutcomeSchema.parse(
      await this.client.call(MACHINE_ROUTES.apply, { params: { proposalId: changeId }, body }),
    );
  }

  async scan(): Promise<SetupScan> {
    return SetupScanSchema.parse(await this.client.call(MACHINE_ROUTES.scan));
  }

  async installTools(harnesses: readonly MachineHarness[]): Promise<ToolInstallResult> {
    const body = ToolInstallRequestSchema.parse({ harnesses: [...harnesses] });
    return ToolInstallResultSchema.parse(await this.client.call(MACHINE_ROUTES.installTools, { body }));
  }

  async exportBundle(): Promise<CloneBundle> {
    return CloneBundleSchema.parse(await this.client.call(MACHINE_ROUTES.exportBundle));
  }

  async reviewClone(request: CloneReviewRequest): Promise<CloneReview> {
    const body = CloneReviewRequestSchema.parse(request);
    return CloneReviewSchema.parse(await this.client.call(MACHINE_ROUTES.reviewClone, { body }));
  }

  async forgetCloneSource(source: string): Promise<boolean> {
    const body = CloneForgetRequestSchema.parse({ source });
    return CloneForgetResultSchema.parse(await this.client.call(MACHINE_ROUTES.forgetClone, { body })).forgotten;
  }
}
