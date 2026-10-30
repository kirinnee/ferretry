import {
  classifyDaemonUnreachable,
  type DaemonAttempt,
  type DaemonRestartPatience,
  daemonStartingOf,
  isRepeatableAgentTool,
  waitOutDaemonRestart,
} from '@ferretry/protocol';
import type { z } from 'zod';
import type { IAgentToolsGateway } from '../../lib/agent-tools/client.ts';
import { isLocalDaemonUrl } from '../../lib/daemon/address.ts';

/** How long one agent tool request may take: a page load (45 s in the worker) or a held-open wait. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Waiting for a restarting daemon: the patience, and the clock it is measured on. */
export interface SessionGatewayRestart {
  readonly patience: DaemonRestartPatience;
  readonly nowMs: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

/**
 * Whether a request the daemon dropped may be sent again: a read, or a tool that changes nothing.
 * These requests carry no request id the daemon could apply once, so a `terminal.send` that was
 * dropped after it typed must not type again.
 */
function repeatable(init: RequestInit): boolean {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return true;
  if (typeof init.body !== 'string') return false;
  try {
    const call: unknown = JSON.parse(init.body);
    return typeof call === 'object' && call !== null && isRepeatableAgentTool((call as { tool?: unknown }).tool);
  } catch {
    return false;
  }
}

/**
 * The daemon, as an AGENT reaches it: with its session credential and nothing else.
 *
 * It sends no bearer token at all — it never reads the host's admin token, and drops an
 * `authorization` header if a caller passed one — because the agent route authenticates the session
 * credential alone, and a tools server that held host authority would be an agent holding it too. It
 * talks only to a daemon on this machine: the agent route is served over loopback only, and a session
 * credential sent anywhere else would be a credential leaving the machine.
 *
 * A RESTART IS WAITED OUT. The MCP tools an agent calls mid-turn are exactly the calls a daemon
 * restart would otherwise fail, so with `restart` given a call the daemon refused is sent again until
 * it is back (`daemon-restart.ts`), and one it dropped mid-request is sent again only when it reads. A
 * daemon that answers it is still STARTING is not back yet: that answer is waited out like a refusal,
 * so a call made across a restart lands once the new daemon serves rather than failing a boot step early.
 */
export class SessionCredentialGateway implements IAgentToolsGateway {
  constructor(
    private readonly baseUrl: () => Promise<string>,
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly restart?: SessionGatewayRestart,
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
    const attempt = async (): Promise<DaemonAttempt<Response>> => {
      try {
        const signal = AbortSignal.timeout(timeoutMs);
        const response = await this.fetcher(`${base}${path}`, { ...init, headers, signal });
        // A daemon that has bound its address but not mounted its routes ran nothing: still away.
        const starting = await daemonStartingOf(response);
        if (starting !== undefined) throw starting;
        return { kind: 'answered', value: response };
      } catch (error) {
        const how = classifyDaemonUnreachable(error);
        return how === undefined ? { kind: 'failed', error } : { kind: 'unreachable', how, error };
      }
    };
    const first = await attempt();
    const outcome =
      this.restart === undefined
        ? first
        : await waitOutDaemonRestart({ ...this.restart, attempt, first, repeatable: repeatable(init) });
    if (outcome.kind !== 'answered') throw outcome.error;
    const response = outcome.value;
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const said = typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
      throw new Error(typeof said === 'string' ? said : `fyd answered HTTP ${String(response.status)}`);
    }
    return schema.parse(body);
  }
}
