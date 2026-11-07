import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import {
  type SignInRuleDraft,
  SignInRuleDraftSchema,
  type SignInRuleEligibility,
  SignInRuleEligibilitySchema,
  type SignInRuleList,
  SignInRuleListSchema,
  type SignInRuleNarrow,
  SignInRuleNarrowSchema,
  type SignInRuleStaged,
  SignInRuleStagedSchema,
  type SignInRuleStageView,
  SignInRuleStageViewSchema,
  type SignInRuleView,
  SignInRuleViewSchema,
} from '../../../contract/routes/index.ts';
import type { IRulesGateway } from './ports.ts';

const DroppedSchema = z.looseObject({ dropped: z.literal(true) });
const RevokedSchema = z.looseObject({ revoked: z.literal(true) });

const AccountRevokedSchema = z.looseObject({ account: z.string(), revoked: z.number().int().min(0) });

/**
 * Speaks the standing sign-in rule routes as the person at this machine, through the plugin's generated client (which
 * never sends a ferret's credential). It has a stage, a confirm-in-app and a view, and NO commit: the commit route needs
 * a passkey proof the machine's token cannot make, so it is the app's alone. Every answer is parsed before it is used.
 */
export class ProtocolRulesGateway implements IRulesGateway {
  constructor(private readonly client: Pick<PluginClient, 'call'>) {}

  async list(): Promise<SignInRuleList> {
    return SignInRuleListSchema.parse(await this.client.call('GET /v1/sign-in-rules'));
  }

  async stage(draft: SignInRuleDraft): Promise<SignInRuleStaged> {
    return SignInRuleStagedSchema.parse(
      await this.client.call('POST /v1/sign-in-rules/stages', { body: SignInRuleDraftSchema.parse(draft) }),
    );
  }

  async confirmInApp(stage: string): Promise<SignInRuleStaged> {
    return SignInRuleStagedSchema.parse(
      await this.client.call('POST /v1/sign-in-rules/stages/:stage/confirm-in-app', { params: { stage } }),
    );
  }

  async view(stage: string): Promise<SignInRuleStageView> {
    return SignInRuleStageViewSchema.parse(
      await this.client.call('GET /v1/sign-in-rules/stages/:stage', { params: { stage } }),
    );
  }

  async drop(stage: string): Promise<void> {
    DroppedSchema.parse(await this.client.call('DELETE /v1/sign-in-rules/stages/:stage', { params: { stage } }));
  }

  async narrow(rule: string, narrow: SignInRuleNarrow): Promise<SignInRuleView> {
    return SignInRuleViewSchema.parse(
      await this.client.call('POST /v1/sign-in-rules/:id/narrow', {
        params: { id: rule },
        body: SignInRuleNarrowSchema.parse(narrow),
      }),
    );
  }

  async revoke(rule: string): Promise<void> {
    RevokedSchema.parse(await this.client.call('DELETE /v1/sign-in-rules/:id', { params: { id: rule } }));
  }

  async revokeAccount(account: string): Promise<number> {
    const answer = AccountRevokedSchema.parse(
      await this.client.call('POST /v1/accounts/:id/sign-in-rules/revoke', { params: { id: account } }),
    );
    return answer.revoked;
  }

  async eligibility(signIn: string): Promise<SignInRuleEligibility> {
    return SignInRuleEligibilitySchema.parse(
      await this.client.call('GET /v1/sign-in-rules/eligibility', { query: { signIn } }),
    );
  }
}
