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
} from '@ferretry/protocol';
import { z } from 'zod';
import { readDaemonFeatures, updateRefusal } from '../daemon/features.ts';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME } from '../session/connection.ts';
import type { IRulesGateway, RulesApiClient } from './ports.ts';

const DroppedSchema = z.looseObject({ dropped: z.literal(true) });
const RevokedSchema = z.looseObject({ revoked: z.literal(true) });

const AccountRevokedSchema = z.looseObject({ account: z.string(), revoked: z.number().int().min(0) });

const stagePath = (stage: string): string => `/v1/sign-in-rules/stages/${encodeURIComponent(stage)}`;

/** What a daemon without the rule routes is too old for, in its update sentence (`daemonNeedsUpdate`). */
export const RULES_FEATURE_WORDS = 'standing sign-in rules';

/** A daemon with no rule routes answers `404 unknown_route`: said as the update it needs, never as a raw 404. */
const tooOld = updateRefusal(RULES_FEATURE_WORDS);

/**
 * Speaks the standing sign-in rule routes as the person at this machine, never with a ferret's session header. It has
 * a stage, a confirm-in-app and a view, and NO commit: the commit route needs a passkey proof the machine's token
 * cannot make, so it is the app's alone. Every route's `404 unknown_route` becomes the one "update the daemon" sentence.
 */
export class ProtocolRulesGateway implements IRulesGateway {
  readonly #headers = { [FY_CLIENT_HEADER]: FY_CLIENT_NAME };
  readonly #json = { 'content-type': 'application/json', ...this.#headers };

  constructor(private readonly client: RulesApiClient) {}

  async list(): Promise<SignInRuleList> {
    return await this.client
      .request('/v1/sign-in-rules', SignInRuleListSchema, { headers: this.#headers })
      .catch(tooOld);
  }

  async stage(draft: SignInRuleDraft): Promise<SignInRuleStaged> {
    return await this.client
      .request('/v1/sign-in-rules/stages', SignInRuleStagedSchema, {
        method: 'POST',
        headers: this.#json,
        body: JSON.stringify(SignInRuleDraftSchema.parse(draft)),
      })
      .catch(tooOld);
  }

  async confirmInApp(stage: string): Promise<SignInRuleStaged> {
    return await this.client
      .request(`${stagePath(stage)}/confirm-in-app`, SignInRuleStagedSchema, {
        method: 'POST',
        headers: this.#headers,
      })
      .catch(tooOld);
  }

  async view(stage: string): Promise<SignInRuleStageView> {
    return await this.client
      .request(stagePath(stage), SignInRuleStageViewSchema, { headers: this.#headers })
      .catch(tooOld);
  }

  async drop(stage: string): Promise<void> {
    await this.client
      .request(stagePath(stage), DroppedSchema, { method: 'DELETE', headers: this.#headers })
      .catch(tooOld);
  }

  async narrow(rule: string, narrow: SignInRuleNarrow): Promise<SignInRuleView> {
    return await this.client
      .request(`/v1/sign-in-rules/${encodeURIComponent(rule)}/narrow`, SignInRuleViewSchema, {
        method: 'POST',
        headers: this.#json,
        body: JSON.stringify(SignInRuleNarrowSchema.parse(narrow)),
      })
      .catch(tooOld);
  }

  async revoke(rule: string): Promise<void> {
    await this.client
      .request(`/v1/sign-in-rules/${encodeURIComponent(rule)}`, RevokedSchema, {
        method: 'DELETE',
        headers: this.#headers,
      })
      .catch(tooOld);
  }

  async revokeAccount(account: string): Promise<number> {
    const answer = await this.client
      .request(`/v1/accounts/${encodeURIComponent(account)}/sign-in-rules/revoke`, AccountRevokedSchema, {
        method: 'POST',
        headers: this.#headers,
      })
      .catch(tooOld);
    return answer.revoked;
  }

  async eligibility(signIn: string): Promise<SignInRuleEligibility> {
    return await this.client
      .request(`/v1/sign-in-rules/eligibility?signIn=${encodeURIComponent(signIn)}`, SignInRuleEligibilitySchema, {
        headers: this.#headers,
      })
      .catch(tooOld);
  }

  async features(): Promise<readonly string[]> {
    return await readDaemonFeatures(this.client);
  }
}
