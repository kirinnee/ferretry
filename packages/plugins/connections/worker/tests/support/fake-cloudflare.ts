/**
 * Cloudflare's tunnel and DNS API, faked down to the behaviour the provisioner depends on.
 *
 * What it models, because the provisioner's correctness rests on each one:
 *
 * - an account holds at most `tunnelLimit` live tunnels (Cloudflare's default is 1,000);
 * - a zone belongs to one account, and a DNS call with another account's token is refused;
 * - a tunnel with live connections refuses deletion with error 1022 until its connections are cleaned up;
 * - deleting a tunnel does NOT delete its CNAME, and a deleted tunnel no longer lists;
 * - a call can fail before it commits, or commit and then lose its answer — the second is how an
 *   orphan would be born, so it is the fault a test most needs to inject.
 *
 * What it does NOT prove is that Cloudflare behaves like this; only a real deployment can, and the
 * runbook says so. Every token it hands out starts with {@link FAKE_CONNECTOR_TOKEN_PREFIX}, so a test
 * can scan any output for one.
 */

import type {
  CloudflareFailureKind,
  CloudflareResult,
  CloudflareTunnelApi,
  TunnelAccount,
  TunnelIngressRule,
} from '../../src/lib/index.ts';

export const FAKE_CONNECTOR_TOKEN_PREFIX = 'fake-connector-token-';

export interface FakeTunnel {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  deleted: boolean;
  connections: number;
  ingress: readonly TunnelIngressRule[] | null;
  readonly token: string;
}

export interface FakeDnsRecord {
  readonly id: string;
  readonly zoneId: string;
  readonly type: 'CNAME';
  readonly name: string;
  readonly content: string;
  readonly proxied: boolean;
}

type Method = keyof CloudflareTunnelApi;

interface Fault {
  readonly kind: CloudflareFailureKind;
  /** Perform the call, then lose the answer. */
  readonly afterCommit: boolean;
}

export class FakeCloudflare implements CloudflareTunnelApi {
  readonly zones = new Map<string, { readonly accountId: string; readonly name: string }>();
  /** The API token each account accepts. A call with any other token is refused, as Cloudflare would. */
  readonly accountTokens = new Map<string, string>();
  readonly tunnels = new Map<string, FakeTunnel>();
  readonly records = new Map<string, FakeDnsRecord>();
  readonly calls: { readonly method: Method; readonly accountId: string }[] = [];
  tunnelLimit = 1000;
  private readonly faults = new Map<Method, Fault[]>();
  private sequence = 0;

  /** Register an account and its zone. `zoneAccountId` puts the zone in ANOTHER account (a misconfiguration). */
  addAccount(account: TunnelAccount, zoneAccountId: string = account.accountId): void {
    this.accountTokens.set(account.accountId, account.apiToken);
    this.zones.set(account.zoneId, { accountId: zoneAccountId, name: account.zone });
  }

  /** The next call to `method` fails; `afterCommit` makes it do its work first and then lose the answer. */
  fail(method: Method, kind: CloudflareFailureKind = 'failed', afterCommit = false): void {
    const queue = this.faults.get(method) ?? [];
    queue.push({ kind, afterCommit });
    this.faults.set(method, queue);
  }

  /** A `cloudflared` registered against this tunnel. */
  connect(tunnelId: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (tunnel !== undefined) tunnel.connections += 1;
  }

  liveTunnels(accountId?: string): FakeTunnel[] {
    return [...this.tunnels.values()].filter(
      tunnel => !tunnel.deleted && (accountId === undefined || tunnel.accountId === accountId),
    );
  }

  count(method: Method): number {
    return this.calls.filter(call => call.method === method).length;
  }

  zone(account: TunnelAccount) {
    return this.run('zone', account, () => {
      const zone = this.zones.get(account.zoneId);
      return zone === undefined ? missing('zone not found') : ok({ accountId: zone.accountId, name: zone.name });
    });
  }

  findTunnel(account: TunnelAccount, name: string) {
    return this.run('findTunnel', account, () => {
      const found = this.liveTunnels(account.accountId).find(tunnel => tunnel.name === name);
      return ok(found === undefined ? null : { id: found.id });
    });
  }

  createTunnel(account: TunnelAccount, name: string) {
    return this.run('createTunnel', account, () => {
      if (this.liveTunnels(account.accountId).length >= this.tunnelLimit) {
        return refused('1013 you have reached the maximum number of tunnels for this account');
      }
      this.sequence += 1;
      const id = `tunnel-${this.sequence}`;
      this.tunnels.set(id, {
        id,
        accountId: account.accountId,
        name,
        deleted: false,
        connections: 0,
        ingress: null,
        token: `${FAKE_CONNECTOR_TOKEN_PREFIX}${id}`,
      });
      return ok({ id });
    });
  }

  configureTunnel(account: TunnelAccount, tunnelId: string, ingress: readonly TunnelIngressRule[]) {
    return this.run('configureTunnel', account, () => {
      const tunnel = this.owned(account, tunnelId);
      if (tunnel === null) return missing('tunnel not found');
      tunnel.ingress = ingress;
      return ok(null);
    });
  }

  tunnelToken(account: TunnelAccount, tunnelId: string) {
    return this.run('tunnelToken', account, () => {
      const tunnel = this.owned(account, tunnelId);
      return tunnel === null ? missing('tunnel not found') : ok(tunnel.token);
    });
  }

  cleanupConnections(account: TunnelAccount, tunnelId: string) {
    return this.run('cleanupConnections', account, () => {
      const tunnel = this.owned(account, tunnelId);
      if (tunnel === null) return missing('tunnel not found');
      tunnel.connections = 0;
      return ok(null);
    });
  }

  deleteTunnel(account: TunnelAccount, tunnelId: string) {
    return this.run('deleteTunnel', account, () => {
      const tunnel = this.owned(account, tunnelId);
      if (tunnel === null) return missing('tunnel not found');
      if (tunnel.connections > 0) return refused('1022 cannot delete a tunnel with active connections');
      tunnel.deleted = true;
      return ok(null);
    });
  }

  findDnsRecord(account: TunnelAccount, hostname: string) {
    return this.run('findDnsRecord', account, () => {
      if (!this.zoneOwned(account)) return refused('10000 authentication error');
      const found = [...this.records.values()].find(
        record => record.zoneId === account.zoneId && record.name === hostname && record.type === 'CNAME',
      );
      return ok(found === undefined ? null : { id: found.id });
    });
  }

  createDnsRecord(account: TunnelAccount, hostname: string, target: string) {
    return this.run('createDnsRecord', account, () => {
      if (!this.zoneOwned(account)) return refused('10000 authentication error');
      if ([...this.records.values()].some(record => record.zoneId === account.zoneId && record.name === hostname)) {
        return refused('81053 an A, AAAA, or CNAME record with that host already exists');
      }
      this.sequence += 1;
      const id = `record-${this.sequence}`;
      this.records.set(id, {
        id,
        zoneId: account.zoneId,
        type: 'CNAME',
        name: hostname,
        content: target,
        proxied: true,
      });
      return ok({ id });
    });
  }

  deleteDnsRecord(account: TunnelAccount, recordId: string) {
    return this.run('deleteDnsRecord', account, () => {
      if (!this.zoneOwned(account)) return refused('10000 authentication error');
      const record = this.records.get(recordId);
      if (record === undefined || record.zoneId !== account.zoneId) return missing('record not found');
      this.records.delete(recordId);
      return ok(null);
    });
  }

  private owned(account: TunnelAccount, tunnelId: string): FakeTunnel | null {
    const tunnel = this.tunnels.get(tunnelId);
    return tunnel === undefined || tunnel.deleted || tunnel.accountId !== account.accountId ? null : tunnel;
  }

  private zoneOwned(account: TunnelAccount): boolean {
    return this.zones.get(account.zoneId)?.accountId === account.accountId;
  }

  private async run<T>(
    method: Method,
    account: TunnelAccount,
    work: () => CloudflareResult<T>,
  ): Promise<CloudflareResult<T>> {
    this.calls.push({ method, accountId: account.accountId });
    if (this.accountTokens.get(account.accountId) !== account.apiToken) return refused('10000 authentication error');
    const fault = this.faults.get(method)?.shift();
    if (fault === undefined) return work();
    if (fault.afterCommit) work();
    return { ok: false, kind: fault.kind, reason: `injected ${fault.kind} on ${method}` };
  }
}

function ok<T>(value: T): CloudflareResult<T> {
  return { ok: true, value };
}

function missing(reason: string): CloudflareResult<never> {
  return { ok: false, kind: 'not_found', reason };
}

function refused(reason: string): CloudflareResult<never> {
  return { ok: false, kind: 'refused', reason };
}
