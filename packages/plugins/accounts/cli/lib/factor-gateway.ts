import {
  type ConfirmTwoFactorSeedRequest,
  ConfirmTwoFactorSeedRequestSchema,
  type StageTwoFactorSeedRequest,
  StageTwoFactorSeedRequestSchema,
  type TwoFactorSeedConfirming,
  TwoFactorSeedConfirmingSchema,
  type TwoFactorSeedStaged,
  TwoFactorSeedStagedSchema,
  type TwoFactorSeedStageView,
  TwoFactorSeedStageViewSchema,
} from '../../contract/routes/index.ts';
import { callDaemon } from '../shell.ts';
import type { AccountApiClient } from './account-ports.ts';

/**
 * The 2FA seed routes `fy account factor add --totp` needs (docs/secrets.md, "2FA keys"): stage, put on the agenda,
 * watch. There is no commit here: a seed is saved only with a passkey, in the app, so this CLI can never save one.
 */
export interface ITwoFactorSeedGateway {
  stage(account: string, body: StageTwoFactorSeedRequest): Promise<TwoFactorSeedStaged>;
  confirmInApp(account: string, stage: string, body: ConfirmTwoFactorSeedRequest): Promise<TwoFactorSeedConfirming>;
  view(account: string, stage: string): Promise<TwoFactorSeedStageView>;
}

/** Speaks the seed routes through the plugin client, parsed both ways. No reply carries a seed. */
export class ProtocolTwoFactorSeedGateway implements ITwoFactorSeedGateway {
  constructor(private readonly client: AccountApiClient) {}

  async stage(account: string, body: StageTwoFactorSeedRequest): Promise<TwoFactorSeedStaged> {
    return TwoFactorSeedStagedSchema.parse(
      await callDaemon(this.client, 'POST /v1/accounts/:id/factors/seed', {
        params: { id: account },
        body: StageTwoFactorSeedRequestSchema.parse(body),
      }),
    );
  }

  async confirmInApp(
    account: string,
    stage: string,
    body: ConfirmTwoFactorSeedRequest,
  ): Promise<TwoFactorSeedConfirming> {
    return TwoFactorSeedConfirmingSchema.parse(
      await callDaemon(this.client, 'POST /v1/accounts/:id/factors/seed/:stage/confirm-in-app', {
        params: { id: account, stage },
        body: ConfirmTwoFactorSeedRequestSchema.parse(body),
      }),
    );
  }

  async view(account: string, stage: string): Promise<TwoFactorSeedStageView> {
    return TwoFactorSeedStageViewSchema.parse(
      await callDaemon(this.client, 'GET /v1/accounts/:id/factors/seed/:stage', { params: { id: account, stage } }),
    );
  }
}
