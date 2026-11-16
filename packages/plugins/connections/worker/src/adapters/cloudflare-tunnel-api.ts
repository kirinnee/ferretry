/**
 * Cloudflare's v4 API, for the hosted tunnel provisioner — the {@link CloudflareTunnelApi} port.
 *
 * Every call carries ONE pool account's API token as a bearer and nothing else carries it: not a URL,
 * not a body, not a returned reason. Cloudflare's answers are parsed through zod at this boundary, so a
 * shape the provisioner did not expect is a typed failure rather than a crash halfway through a step.
 * Error reasons quote Cloudflare's own error codes and messages, which name what went wrong and never a
 * credential; the account's token is still scrubbed from them, because a defence that depends on a
 * remote service's wording is not one.
 */

import { z } from 'zod';
import type {
  CloudflareFailureKind,
  CloudflareResult,
  CloudflareTunnelApi,
  TunnelAccount,
  TunnelIngressRule,
} from '../lib/index.ts';

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4' as const;

/** The one network primitive this adapter needs, injected so tests never reach the network. */
export type CloudflareFetch = (request: Request) => Promise<Response>;

const EnvelopeSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number(), message: z.string() })).default([]),
  result: z.unknown(),
});

const IdentifiedSchema = z.object({ id: z.string().min(1) });
const IdentifiedListSchema = z.array(IdentifiedSchema);
const ZoneSchema = z.object({ id: z.string(), name: z.string(), account: z.object({ id: z.string() }) });
const TokenSchema = z.string().min(1);
const IgnoredSchema = z.unknown();

export class CloudflareFetchTunnelApi implements CloudflareTunnelApi {
  constructor(
    private readonly fetcher: CloudflareFetch = request => fetch(request),
    private readonly base: string = CLOUDFLARE_API_BASE,
  ) {}

  async zone(account: TunnelAccount) {
    const answer = await this.call(account, 'GET', `/zones/${path(account.zoneId)}`, undefined, ZoneSchema);
    return answer.ok ? ok({ accountId: answer.value.account.id, name: answer.value.name }) : answer;
  }

  async findTunnel(account: TunnelAccount, name: string) {
    const query = new URLSearchParams({ name, is_deleted: 'false' });
    const answer = await this.call(
      account,
      'GET',
      `/accounts/${path(account.accountId)}/cfd_tunnel?${query}`,
      undefined,
      IdentifiedListSchema,
    );
    return answer.ok ? ok(firstId(answer.value)) : answer;
  }

  async createTunnel(account: TunnelAccount, name: string) {
    const answer = await this.call(
      account,
      'POST',
      `/accounts/${path(account.accountId)}/cfd_tunnel`,
      { name, config_src: 'cloudflare' },
      IdentifiedSchema,
    );
    return answer.ok ? ok({ id: answer.value.id }) : answer;
  }

  async configureTunnel(account: TunnelAccount, tunnelId: string, ingress: readonly TunnelIngressRule[]) {
    const answer = await this.call(
      account,
      'PUT',
      `/accounts/${path(account.accountId)}/cfd_tunnel/${path(tunnelId)}/configurations`,
      { config: { ingress } },
      IgnoredSchema,
    );
    return answer.ok ? ok(null) : answer;
  }

  tunnelToken(account: TunnelAccount, tunnelId: string) {
    return this.call(
      account,
      'GET',
      `/accounts/${path(account.accountId)}/cfd_tunnel/${path(tunnelId)}/token`,
      undefined,
      TokenSchema,
    );
  }

  async cleanupConnections(account: TunnelAccount, tunnelId: string) {
    const answer = await this.call(
      account,
      'DELETE',
      `/accounts/${path(account.accountId)}/cfd_tunnel/${path(tunnelId)}/connections`,
      undefined,
      IgnoredSchema,
    );
    return answer.ok ? ok(null) : answer;
  }

  async deleteTunnel(account: TunnelAccount, tunnelId: string) {
    const answer = await this.call(
      account,
      'DELETE',
      `/accounts/${path(account.accountId)}/cfd_tunnel/${path(tunnelId)}`,
      undefined,
      IgnoredSchema,
    );
    return answer.ok ? ok(null) : answer;
  }

  async findDnsRecord(account: TunnelAccount, hostname: string) {
    const query = new URLSearchParams({ type: 'CNAME', name: hostname });
    const answer = await this.call(
      account,
      'GET',
      `/zones/${path(account.zoneId)}/dns_records?${query}`,
      undefined,
      IdentifiedListSchema,
    );
    return answer.ok ? ok(firstId(answer.value)) : answer;
  }

  async createDnsRecord(account: TunnelAccount, hostname: string, target: string) {
    const answer = await this.call(
      account,
      'POST',
      `/zones/${path(account.zoneId)}/dns_records`,
      { type: 'CNAME', proxied: true, name: hostname, content: target, comment: 'ferretry hosted tunnel' },
      IdentifiedSchema,
    );
    return answer.ok ? ok({ id: answer.value.id }) : answer;
  }

  async deleteDnsRecord(account: TunnelAccount, recordId: string) {
    const answer = await this.call(
      account,
      'DELETE',
      `/zones/${path(account.zoneId)}/dns_records/${path(recordId)}`,
      undefined,
      IgnoredSchema,
    );
    return answer.ok ? ok(null) : answer;
  }

  private async call<T extends z.ZodType>(
    account: TunnelAccount,
    method: string,
    route: string,
    body: unknown,
    schema: T,
  ): Promise<CloudflareResult<z.infer<T>>> {
    let response: Response;
    try {
      response = await this.fetcher(
        new Request(`${this.base}${route}`, {
          method,
          headers: { Authorization: `Bearer ${account.apiToken}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    } catch {
      return failure('failed', `${method} ${redactedRoute(route)} could not reach Cloudflare`);
    }
    let envelope: z.infer<typeof EnvelopeSchema>;
    try {
      envelope = EnvelopeSchema.parse(await response.json());
    } catch {
      return failure(
        kindOf(response.status),
        `${method} ${redactedRoute(route)} answered ${response.status} unreadably`,
      );
    }
    if (!response.ok || !envelope.success) {
      const errors = envelope.errors
        .slice(0, 3)
        .map(error => `${error.code} ${error.message}`)
        .join('; ');
      const reason = `${method} ${redactedRoute(route)} answered ${response.status}${errors === '' ? '' : `: ${errors}`}`;
      return failure(kindOf(response.status), reason.replaceAll(account.apiToken, '[redacted]').slice(0, 400));
    }
    const result = schema.safeParse(envelope.result);
    if (!result.success) return failure('failed', `${method} ${redactedRoute(route)} answered an unexpected shape`);
    return ok(result.data);
  }
}

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

function failure(kind: CloudflareFailureKind, reason: string) {
  return { ok: false as const, kind, reason };
}

/** 404 is "already gone"; any other 4xx but a rate limit is the request's own fault; the rest may pass on retry. */
function kindOf(status: number): CloudflareFailureKind {
  if (status === 404) return 'not_found';
  return status >= 400 && status < 500 && status !== 429 ? 'refused' : 'failed';
}

function firstId(list: readonly { readonly id: string }[]): { readonly id: string } | null {
  const first = list[0];
  return first === undefined ? null : { id: first.id };
}

function path(segment: string): string {
  return encodeURIComponent(segment);
}

/** Routes are logged without their query: a hostname in a lookup is not a secret, but it is not needed. */
function redactedRoute(route: string): string {
  return route.split('?')[0] as string;
}
