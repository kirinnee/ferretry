import {
  CONVERSATION_ADOPT_PATH,
  CONVERSATION_IMPORT_PATH,
  type ConversationAdoptRequest,
  ConversationAdoptRequestSchema,
  type ConversationAdoptResult,
  ConversationAdoptResultSchema,
  type ConversationImportListing,
  ConversationImportListingSchema,
  type Harness,
  type IFyApiClient,
} from '@ferretry/protocol';

/** The only client capability the import gateway needs — the shared daemon client's generic `request`. */
export type ImportApiClient = Pick<IFyApiClient, 'request'>;

/**
 * How a listing is narrowed. Every field is optional and the search itself runs ON THE DAEMON over
 * its own metadata index (`docs` in `packages/protocol/src/lib/conversation-import.ts`) — this CLI
 * never filters a listing it already has, so a result and its `matched` count always agree.
 */
export interface ImportSearchQuery {
  readonly harness?: Harness;
  /** Case-insensitive words; each must appear in the preview, the latest message or the project folder. */
  readonly q?: string;
  /** An ISO instant: only conversations active at or after it. */
  readonly since?: string;
  readonly limit?: number;
}

/** The two conversation-import routes, spoken through the shared client. */
export interface IImportGateway {
  list(query?: ImportSearchQuery): Promise<ConversationImportListing>;
  adopt(request: ConversationAdoptRequest): Promise<ConversationAdoptResult>;
}

/** Terminal output shared by `fy import conversations` and `fy new --continue`. */
export interface IImportOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

function searchParams(query: ImportSearchQuery): string {
  const params = new URLSearchParams();
  if (query.harness !== undefined) params.set('harness', query.harness);
  if (query.q !== undefined && query.q !== '') params.set('q', query.q);
  if (query.since !== undefined) params.set('since', query.since);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  return params.toString();
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Speaks the conversation-import routes through the shared daemon client's generic
 * `request(path, schema, init)` — there is no dedicated `IFyApiClient` method for either route.
 */
export class ProtocolImportGateway implements IImportGateway {
  constructor(private readonly client: ImportApiClient) {}

  async list(query: ImportSearchQuery = {}): Promise<ConversationImportListing> {
    const params = searchParams(query);
    return await this.client.request(
      params === '' ? CONVERSATION_IMPORT_PATH : `${CONVERSATION_IMPORT_PATH}?${params}`,
      ConversationImportListingSchema,
    );
  }

  async adopt(request: ConversationAdoptRequest): Promise<ConversationAdoptResult> {
    const body = ConversationAdoptRequestSchema.parse(request);
    return await this.client.request(CONVERSATION_ADOPT_PATH, ConversationAdoptResultSchema, post(body));
  }
}
