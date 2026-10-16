import type { z } from 'zod';
import type { IAgentToolsGateway } from '../../lib/agent-tools/client.ts';
import { isLocalDaemonUrl } from '../../lib/daemon/address.ts';

/** How long one agent tool request may take: a page load (45 s in the worker) or a held-open wait. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The daemon, as an AGENT reaches it: with its session credential and nothing else.
 *
 * It sends no bearer token at all — it never reads the host's admin token, and drops an
 * `authorization` header if a caller passed one — because the agent route authenticates the session
 * credential alone, and a tools server that held host authority would be an agent holding it too. It
 * talks only to a daemon on this machine: the agent route is served over loopback only, and a session
 * credential sent anywhere else would be a credential leaving the machine.
 */
export class SessionCredentialGateway implements IAgentToolsGateway {
  constructor(
    private readonly baseUrl: () => Promise<string>,
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {}

  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const base = await this.baseUrl();
    if (!isLocalDaemonUrl(base))
      throw new Error(`the agent tools talk only to the daemon on this machine, and ${base} is not on it`);
    const headers = new Headers(init.headers);
    headers.delete('authorization');
    const response = await this.fetcher(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const said = typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
      throw new Error(typeof said === 'string' ? said : `fyd answered HTTP ${String(response.status)}`);
    }
    return schema.parse(body);
  }
}
