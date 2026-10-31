import {
  type LoginEntryList,
  LoginEntryListSchema,
  type LoginEntrySummary,
  LoginEntrySummarySchema,
  type LoginHintList,
  LoginHintListSchema,
  type LoginRecipeDecision,
  LoginRecipeDecisionSchema,
  type PutLoginEntryRequest,
  PutLoginEntryRequestSchema,
  type RemovedLoginEntry,
  RemovedLoginEntrySchema,
  RenameLoginEntryRequestSchema,
} from '@ferretry/protocol';
import type { ILoginEntryGateway, LoginEntryApiClient } from './entry-ports.ts';

/** The daemon's saved-login surface, beside the secret store it is sealed in. */
export const LOGIN_ENTRIES_PATH = '/v1/secrets/logins';

function entryPath(id: string): string {
  return `${LOGIN_ENTRIES_PATH}/${encodeURIComponent(id)}`;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * Speaks the saved-login routes through the protocol client. Bodies are parsed against the protocol
 * schemas in both directions; nothing here logs one, and no reply carries a value.
 */
export class ProtocolLoginEntryGateway implements ILoginEntryGateway {
  constructor(private readonly client: LoginEntryApiClient) {}

  async list(): Promise<LoginEntryList> {
    return await this.client.request(LOGIN_ENTRIES_PATH, LoginEntryListSchema);
  }

  async put(id: string, body: PutLoginEntryRequest): Promise<LoginEntrySummary> {
    return await this.client.request(entryPath(id), LoginEntrySummarySchema, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(PutLoginEntryRequestSchema.parse(body)),
    });
  }

  async rename(id: string, to: string): Promise<LoginEntrySummary> {
    return await this.client.request(`${entryPath(id)}/rename`, LoginEntrySummarySchema, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(RenameLoginEntryRequestSchema.parse({ to })),
    });
  }

  async hint(site: string): Promise<LoginHintList> {
    return await this.client.request(
      `${LOGIN_ENTRIES_PATH}/hint?site=${encodeURIComponent(site)}`,
      LoginHintListSchema,
    );
  }

  async decideRecipe(
    id: string,
    proposalId: string,
    decision: LoginRecipeDecision['decision'],
  ): Promise<LoginEntrySummary> {
    return await this.client.request(
      `${entryPath(id)}/recipe/proposals/${encodeURIComponent(proposalId)}`,
      LoginEntrySummarySchema,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(LoginRecipeDecisionSchema.parse({ decision })) },
    );
  }

  async remove(id: string): Promise<RemovedLoginEntry> {
    return await this.client.request(entryPath(id), RemovedLoginEntrySchema, { method: 'DELETE' });
  }
}
