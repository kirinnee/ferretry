/** In-memory seams for the MCP sign-in service, and a world that wires them to a fake provider. */
import type { SecretName, SecretSummary } from '@ferretry/protocol';
import type {
  McpOAuthCrypto,
  McpOAuthHttp,
  McpOAuthHttpRequest,
  McpOAuthHttpResponse,
  McpOAuthSecretValues,
  McpOAuthSecretWriter,
  McpOAuthServer,
  McpOAuthStateDocument,
  McpOAuthStateStore,
} from '../../../src/lib/mcp-oauth/index.ts';
import { EMPTY_MCP_OAUTH_STATE, McpOAuthService, McpOAuthUnreachable } from '../../../src/lib/mcp-oauth/index.ts';
import { FakeProvider, type FakeProviderOptions } from './fake-provider.ts';

const ORIGIN = 'http://127.0.0.1:4100';
export const PWA_REDIRECT = 'https://ferretry.example.test/oauth/mcp-callback';

/**
 * The network, answered in process by one handler. A URL in `failing` raises like a dead host, with
 * `failure` as the transport's code, as the fetch adapter does.
 */
class InProcessHttp implements McpOAuthHttp {
  readonly requests: McpOAuthHttpRequest[] = [];
  readonly failing = new Set<string>();
  failure = 'ConnectionRefused';

  constructor(private readonly handler: (request: Request) => Promise<Response>) {}

  async request(request: McpOAuthHttpRequest): Promise<McpOAuthHttpResponse> {
    this.requests.push(request);
    if (this.failing.has(request.url)) throw new McpOAuthUnreachable(this.failure);
    const response = await this.handler(
      new Request(request.url, {
        method: request.method,
        headers: request.headers ?? {},
        ...(request.body === undefined ? {} : { body: request.body }),
      }),
    );
    return {
      status: response.status,
      header: name => response.headers.get(name) ?? undefined,
      text: await response.text(),
    };
  }
}

class MemoryState implements McpOAuthStateStore {
  document: McpOAuthStateDocument = EMPTY_MCP_OAUTH_STATE;
  failure: Error | undefined;

  async read(): Promise<McpOAuthStateDocument> {
    if (this.failure !== undefined) throw this.failure;
    return this.document;
  }

  async write(document: McpOAuthStateDocument): Promise<void> {
    this.document = document;
  }
}

/** Both halves of the store over one map, so a test can see what was filed. */
class MemorySecrets implements McpOAuthSecretWriter, McpOAuthSecretValues {
  readonly entries = new Map<SecretName, string>();

  async list(): Promise<readonly SecretSummary[]> {
    return [...this.entries.keys()].map(name => ({ name, createdAt: 'x', updatedAt: 'x' }));
  }

  async put(name: SecretName, value: string): Promise<SecretSummary> {
    this.entries.set(name, value);
    return { name, createdAt: 'x', updatedAt: 'x' };
  }

  async remove(name: SecretName): Promise<boolean> {
    return this.entries.delete(name);
  }

  async values(): Promise<ReadonlyMap<SecretName, string>> {
    return new Map(this.entries);
  }
}

export const testCrypto: McpOAuthCrypto = {
  randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
  sha256: async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
};

export interface World {
  readonly provider: FakeProvider;
  readonly http: InProcessHttp;
  readonly state: MemoryState;
  readonly secrets: MemorySecrets;
  readonly internal: MemorySecrets;
  readonly clock: { now: () => number; at: number };
  servers: McpOAuthServer[];
  readonly service: McpOAuthService;
}

export function world(options: FakeProviderOptions = {}): World {
  const provider = new FakeProvider(ORIGIN, options);
  const http = new InProcessHttp(provider.handle);
  const state = new MemoryState();
  const secrets = new MemorySecrets();
  const internal = new MemorySecrets();
  const clock = {
    at: Date.parse('2026-10-16T00:00:00.000Z'),
    now(): number {
      return this.at;
    },
  };
  const built: World = {
    provider,
    http,
    state,
    secrets,
    internal,
    clock,
    servers: [
      { component: 'linear', url: provider.serverUrl, auth: 'oauth' },
      { component: 'plain', url: provider.serverUrl },
      { component: 'local', auth: 'oauth' },
    ],
    service: undefined as unknown as McpOAuthService,
  };
  const service = new McpOAuthService({
    servers: { list: async () => built.servers },
    http,
    crypto: testCrypto,
    clock,
    state,
    secrets,
    values: secrets,
    internal,
  });
  return Object.assign(built, { service });
}

/** Every string anywhere in `value`, flattened, for "does any issued token appear in it" checks. */
export function leaks(provider: FakeProvider, ...values: unknown[]): readonly string[] {
  const text = values.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join('\n');
  return [...provider.issued, ...provider.authorizationCodes].filter(token => text.includes(token));
}
