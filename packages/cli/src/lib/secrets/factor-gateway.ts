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
} from '@ferretry/protocol';
import type { LoginEntryApiClient } from './entry-ports.ts';

/**
 * The 2FA seed routes `fy account factor add --totp` needs (docs/secrets.md, "2FA keys"): stage, put on the agenda,
 * watch. There is no commit here: a seed is saved only with a passkey, in the app, so this CLI can never save one.
 */
export interface ITwoFactorSeedGateway {
  stage(account: string, body: StageTwoFactorSeedRequest): Promise<TwoFactorSeedStaged>;
  confirmInApp(account: string, stage: string, body: ConfirmTwoFactorSeedRequest): Promise<TwoFactorSeedConfirming>;
  view(account: string, stage: string): Promise<TwoFactorSeedStageView>;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Speaks the seed routes through the protocol client, parsed both ways. No reply carries a seed. */
export class ProtocolTwoFactorSeedGateway implements ITwoFactorSeedGateway {
  constructor(private readonly client: LoginEntryApiClient) {}

  async stage(account: string, body: StageTwoFactorSeedRequest): Promise<TwoFactorSeedStaged> {
    return await this.client.request(
      `/v1/accounts/${encodeURIComponent(account)}/factors/seed`,
      TwoFactorSeedStagedSchema,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(StageTwoFactorSeedRequestSchema.parse(body)),
      },
    );
  }

  async confirmInApp(
    account: string,
    stage: string,
    body: ConfirmTwoFactorSeedRequest,
  ): Promise<TwoFactorSeedConfirming> {
    return await this.client.request(
      `/v1/accounts/${encodeURIComponent(account)}/factors/seed/${encodeURIComponent(stage)}/confirm-in-app`,
      TwoFactorSeedConfirmingSchema,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(ConfirmTwoFactorSeedRequestSchema.parse(body)),
      },
    );
  }

  async view(account: string, stage: string): Promise<TwoFactorSeedStageView> {
    return await this.client.request(
      `/v1/accounts/${encodeURIComponent(account)}/factors/seed/${encodeURIComponent(stage)}`,
      TwoFactorSeedStageViewSchema,
    );
  }
}
