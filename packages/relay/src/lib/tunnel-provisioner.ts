/**
 * THE HOSTED TUNNEL PROVISIONER — `docs/relay-protocol.md` §15, sequenced against two ports.
 *
 * It decides nothing `tunnel-pool.ts` does not already decide; it orders the calls. The ordering is the
 * point: a row is written before Cloudflare is asked to create anything, and each step's result is
 * written before the next step starts, so whatever fails — a Cloudflare error, a lost answer, an evicted
 * Durable Object — leaves a row that names what exists upstream and what is still missing. A retry
 * resumes from it; the reclaim deletes from it. Nothing this class does can leave a tunnel nobody records.
 *
 * Serialisation is the caller's job. Two provisions for one daemon interleaving would each place a
 * tunnel, so the Durable Object runs one call at a time; nothing here assumes otherwise.
 */

import { fromBase64Url } from './binary.ts';
import { NONCE_BYTES } from './constants.ts';
import type { RelayCrypto } from './crypto.ts';
import {
  DEFAULT_TUNNEL_RENEW_SECONDS,
  TUNNEL_CHALLENGE_SECONDS,
  TUNNEL_SERVICE_VERSION,
  type TunnelAccount,
  type TunnelAction,
  type TunnelChallenge,
  type TunnelChallengeRequest,
  type TunnelIngressRule,
  type TunnelProvision,
  type TunnelProvisionRequest,
  type TunnelRefusalCode,
  type TunnelRelease,
  type TunnelReleaseRequest,
  type TunnelServiceAdvertisement,
  tunnelIngress,
  verifyTunnelRequest,
} from './tunnel.ts';
import {
  issueTunnelChallenge,
  spendTunnelChallenge,
  TUNNEL_LABEL_BYTES,
  type TunnelAccountStanding,
  type TunnelChallengeBook,
  type TunnelOperatorStatus,
  type TunnelPoolState,
  type TunnelRow,
  type TunnelSettings,
  type TunnelZoneVerdict,
  tunnelAccountStanding,
  tunnelCnameTarget,
  tunnelLabel,
  tunnelName,
  tunnelOperatorStatus,
  tunnelPlacementRefusal,
  tunnelRowAccount,
  tunnelRowVerdict,
  tunnelServiceAvailable,
  tunnelZoneCheck,
  tunnelZoneMatches,
} from './tunnel-pool.ts';

// ─── ports ────────────────────────────────────────────────────────────────────────────────────

/**
 * How a Cloudflare call failed. `not_found` lets a delete treat "already gone" as done; `refused` is a
 * 4xx the request itself caused (a token without the permission, a zone in another account); `failed`
 * is everything that might succeed on a retry.
 */
export type CloudflareFailureKind = 'not_found' | 'refused' | 'failed';

export type CloudflareResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: CloudflareFailureKind; readonly reason: string };

/**
 * The slice of Cloudflare's v4 API the provisioner uses, per pool account. An implementation sends the
 * account's own API token and NEVER puts it, or a connector token, into a `reason`.
 */
export interface CloudflareTunnelApi {
  zone(account: TunnelAccount): Promise<CloudflareResult<{ readonly accountId: string; readonly name: string }>>;
  findTunnel(account: TunnelAccount, name: string): Promise<CloudflareResult<{ readonly id: string } | null>>;
  createTunnel(account: TunnelAccount, name: string): Promise<CloudflareResult<{ readonly id: string }>>;
  configureTunnel(
    account: TunnelAccount,
    tunnelId: string,
    ingress: readonly TunnelIngressRule[],
  ): Promise<CloudflareResult<null>>;
  /** The connector token. Fetched on every provision rather than stored: the service keeps no credential it can re-read. */
  tunnelToken(account: TunnelAccount, tunnelId: string): Promise<CloudflareResult<string>>;
  cleanupConnections(account: TunnelAccount, tunnelId: string): Promise<CloudflareResult<null>>;
  deleteTunnel(account: TunnelAccount, tunnelId: string): Promise<CloudflareResult<null>>;
  findDnsRecord(account: TunnelAccount, hostname: string): Promise<CloudflareResult<{ readonly id: string } | null>>;
  createDnsRecord(
    account: TunnelAccount,
    hostname: string,
    target: string,
  ): Promise<CloudflareResult<{ readonly id: string }>>;
  deleteDnsRecord(account: TunnelAccount, recordId: string): Promise<CloudflareResult<null>>;
}

export interface TunnelRowPage {
  readonly rows: readonly TunnelRow[];
  /** Rows on this page that would not parse; skipped, and counted so the operator sees them. */
  readonly damaged: number;
  /** Where the next page starts, or null on the last one. */
  readonly next: string | null;
}

/**
 * Durable state. An ACTIVE row is a daemon's current tunnel, one per daemon. A RETIRED row is a tunnel
 * taken off its daemon (released, reclaimed or orphaned by a removed account) whose upstream deletion
 * has not finished — keyed by its label, so a daemon can get a new tunnel while its old one is deleted.
 * Both kinds count against their account's capacity, because both still exist on Cloudflare.
 */
export interface TunnelStore {
  /** This daemon's active row; throws {@link TunnelStateDamagedError} when the stored row will not parse. */
  activeRow(daemonId: string): Promise<TunnelRow | null>;
  saveActive(row: TunnelRow): Promise<void>;
  /** Atomically move an active row to the retired set. */
  retire(row: TunnelRow): Promise<void>;
  saveRetired(row: TunnelRow): Promise<void>;
  /** Drop a retired row whose every upstream deletion step succeeded. */
  forget(row: TunnelRow): Promise<void>;
  activeRows(after: string | null, limit: number): Promise<TunnelRowPage>;
  retiredRows(after: string | null, limit: number): Promise<TunnelRowPage>;
  /** Tunnels (active and retired) recorded on this account id, counted up to `limit`. */
  countOnAccount(accountId: string, limit: number): Promise<number>;
  zoneVerdicts(): Promise<ReadonlyMap<string, TunnelZoneVerdict>>;
  saveZoneVerdict(verdict: TunnelZoneVerdict): Promise<void>;
  challengeBook(): Promise<TunnelChallengeBook>;
  saveChallengeBook(book: TunnelChallengeBook): Promise<void>;
  settings(): Promise<TunnelSettings>;
  saveSettings(settings: TunnelSettings): Promise<void>;
}

/** A stored row exists and will not parse: provisioning over it could strand the tunnel it records. */
export class TunnelStateDamagedError extends Error {
  constructor(what: string) {
    super(`tunnel service state is damaged: ${what}`);
    this.name = 'TunnelStateDamagedError';
  }
}

// ─── the service ──────────────────────────────────────────────────────────────────────────────

export type TunnelOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: TunnelRefusalCode;
      readonly message: string;
      /** Operator-facing: what Cloudflare said. For a log line, never for the daemon's answer. */
      readonly detail?: string;
    };

export interface TunnelReclaimReport {
  /** Active rows taken off their daemon this pass. */
  readonly retired: number;
  /** Retired rows whose upstream deletion finished this pass. */
  readonly deleted: number;
  /** Retired rows whose deletion failed a step and stay queued. */
  readonly failed: number;
  /** Rows (active or retired) on an account the pool no longer holds. */
  readonly orphaned: number;
  /** The pass stopped at its deletion budget; run again soon rather than tomorrow. */
  readonly more: boolean;
  /** Operator-facing reasons for each failed deletion. */
  readonly problems: readonly string[];
}

export interface TunnelProvisionerDependencies {
  readonly api: CloudflareTunnelApi;
  readonly store: TunnelStore;
  readonly crypto: RelayCrypto;
  now(): number;
}

/**
 * Deletions one reclaim pass attempts. Each costs up to five Cloudflare calls, and a Durable Object
 * alarm on the Workers Free plan may make fifty subrequests, so a pass stops here and the alarm comes
 * back in a minute for the rest.
 */
export const TUNNEL_RECLAIM_DELETIONS_PER_PASS = 8;
const PAGE_SIZE = 256;

type Upstream<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

export class TunnelProvisioner {
  // A plain field, not a parameter property: `src/lib` is also loaded by Node's strip-only TypeScript
  // (the PWA's `vite.config.ts` imports this package), which refuses parameter properties.
  private readonly dependencies: TunnelProvisionerDependencies;

  constructor(dependencies: TunnelProvisionerDependencies) {
    this.dependencies = dependencies;
  }

  /** `GET /v1/tunnel-service`. */
  async advertise(pool: TunnelPoolState): Promise<TunnelServiceAdvertisement> {
    const verdicts = pool.kind === 'ready' ? await this.dependencies.store.zoneVerdicts() : new Map();
    return {
      version: TUNNEL_SERVICE_VERSION,
      available: tunnelServiceAvailable(pool, verdicts, this.dependencies.now()),
    };
  }

  /** `POST /v1/tunnel/challenge`. A pool that is not set up issues nothing, so it stores nothing. */
  async challenge(pool: TunnelPoolState, request: TunnelChallengeRequest): Promise<TunnelOutcome<TunnelChallenge>> {
    if (pool.kind !== 'ready') return unavailable();
    const { store, crypto } = this.dependencies;
    const issued = issueTunnelChallenge(
      await store.challengeBook(),
      request.daemonId,
      crypto.randomBytes(NONCE_BYTES),
      this.dependencies.now(),
    );
    await store.saveChallengeBook(issued.book);
    if (!issued.ok) return { ok: false, code: 'tunnel_rate_limited', message: issued.reason };
    return {
      ok: true,
      value: { version: TUNNEL_SERVICE_VERSION, nonce: issued.nonce, deadlineSeconds: TUNNEL_CHALLENGE_SECONDS },
    };
  }

  /**
   * `POST /v1/tunnel/provision`: idempotent per daemon. An existing tunnel is finished if a step is
   * missing, re-pointed if the port changed, stamped, and its token fetched; otherwise a new one is placed
   * on the first account in the pool's order that can take it.
   */
  async provision(
    pool: TunnelPoolState,
    host: string,
    request: TunnelProvisionRequest,
  ): Promise<TunnelOutcome<TunnelProvision>> {
    if (pool.kind !== 'ready') return unavailable();
    const claim = await this.claim('provision', host, request, request.originPort);
    if (!claim.ok) return claim;
    const { store, api } = this.dependencies;

    let row = await store.activeRow(request.daemonId);
    let account = row === null ? null : tunnelRowAccount(pool, row);
    if (row !== null && account === null) {
      // Its account left the pool, so no token can renew or delete it. Retire it — it stays reported as
      // orphaned, and is deleted if the account ever returns — and give the daemon a tunnel it can use.
      await store.retire(row);
      row = null;
    }
    if (row === null || account === null) {
      const placed = await this.place(pool, request.daemonId, request.originPort);
      if (!placed.ok) return placed;
      ({ row, account } = placed.value);
    } else if (row.originPort !== request.originPort) {
      row = { ...row, originPort: request.originPort };
      await store.saveActive(row);
    }

    const finished = await this.finish(row, account);
    if (!finished.ok) return upstreamFailed(finished.detail);
    const tunnelId = finished.value.tunnelId as string;
    const token = await api.tunnelToken(account, tunnelId);
    if (!token.ok) return upstreamFailed(`read the connector token: ${token.reason}`);
    await store.saveActive({ ...finished.value, lastSeenAt: this.dependencies.now() });
    return {
      ok: true,
      value: {
        version: TUNNEL_SERVICE_VERSION,
        tunnelUrl: `https://${finished.value.hostname}`,
        connectorToken: token.value,
        renewAfterSeconds: DEFAULT_TUNNEL_RENEW_SECONDS,
      },
    };
  }

  /**
   * `POST /v1/tunnel/release`. The tunnel is taken off the daemon at once and deleted upstream now if
   * Cloudflare cooperates; a step that fails is the reclaim's to finish, so the answer never waits on it.
   */
  async release(
    pool: TunnelPoolState,
    host: string,
    request: TunnelReleaseRequest,
  ): Promise<TunnelOutcome<TunnelRelease & { readonly problem?: string }>> {
    if (pool.kind !== 'ready') return unavailable();
    const claim = await this.claim('release', host, request, undefined);
    if (!claim.ok) return claim;
    const { store } = this.dependencies;
    const row = await store.activeRow(request.daemonId);
    if (row === null) return { ok: true, value: { version: TUNNEL_SERVICE_VERSION, released: false } };
    await store.retire(row);
    const account = tunnelRowAccount(pool, row);
    const deleted = account === null ? null : await this.delete(row, account);
    return {
      ok: true,
      value: {
        version: TUNNEL_SERVICE_VERSION,
        released: true,
        ...(deleted !== null && !deleted.ok ? { problem: deleted.detail } : {}),
      },
    };
  }

  /**
   * The daily alarm. Retires every active row past its window, then works through the retired set
   * within the pass's deletion budget. Rows on an account the pool no longer holds are counted and left
   * alone: retrying them would send no token at all.
   */
  async reclaim(pool: TunnelPoolState): Promise<TunnelReclaimReport> {
    const { store } = this.dependencies;
    const settings = await store.settings();
    const now = this.dependencies.now();
    let retired = 0;
    let orphaned = 0;
    for await (const row of this.rows('active')) {
      const verdict = tunnelRowVerdict(row, tunnelRowAccount(pool, row), settings, now);
      if (verdict === 'orphaned') orphaned += 1;
      if (verdict === 'retire') {
        await store.retire(row);
        retired += 1;
      }
    }
    let deleted = 0;
    let failed = 0;
    let more = false;
    const problems: string[] = [];
    for await (const row of this.rows('retired')) {
      const account = tunnelRowAccount(pool, row);
      if (account === null) {
        orphaned += 1;
        continue;
      }
      if (deleted + failed >= TUNNEL_RECLAIM_DELETIONS_PER_PASS) {
        more = true;
        break;
      }
      const outcome = await this.delete(row, account);
      if (outcome.ok) deleted += 1;
      else {
        failed += 1;
        problems.push(`${row.account}/${row.label}: ${outcome.detail}`);
      }
    }
    return { retired, deleted, failed, orphaned, more, problems };
  }

  /** `GET /v1/operator/tunnels`. */
  async status(pool: TunnelPoolState): Promise<TunnelOperatorStatus> {
    const { store } = this.dependencies;
    const liveByAccountId = new Map<string, number>();
    const orphanedRows: TunnelRow[] = [];
    let pendingDeletions = 0;
    let damagedRows = 0;
    for (const kind of ['active', 'retired'] as const) {
      const rows = this.rows(kind, damaged => {
        damagedRows += damaged;
      });
      for await (const row of rows) {
        if (tunnelRowAccount(pool, row) === null) {
          orphanedRows.push(row);
          continue;
        }
        liveByAccountId.set(row.accountId, (liveByAccountId.get(row.accountId) ?? 0) + 1);
        if (kind === 'retired') pendingDeletions += 1;
      }
    }
    return tunnelOperatorStatus(
      pool,
      await store.settings(),
      await store.zoneVerdicts(),
      { liveByAccountId, orphanedRows, pendingDeletions, damagedRows },
      this.dependencies.now(),
    );
  }

  /** `PUT /v1/operator/tunnels`. */
  async configure(settings: TunnelSettings): Promise<TunnelSettings> {
    await this.dependencies.store.saveSettings(settings);
    return settings;
  }

  // ─── steps ──────────────────────────────────────────────────────────────────────────────────

  /** Spend the nonce, then verify the signature over the transcript rebuilt from THIS service's host. */
  private async claim(
    action: TunnelAction,
    host: string,
    request: TunnelReleaseRequest,
    originPort: number | undefined,
  ): Promise<TunnelOutcome<null>> {
    const { store, crypto } = this.dependencies;
    const spent = spendTunnelChallenge(
      await store.challengeBook(),
      request.daemonId,
      request.nonce,
      this.dependencies.now(),
    );
    await store.saveChallengeBook(spent.book);
    if (!spent.valid) {
      return {
        ok: false,
        code: 'tunnel_challenge_expired',
        message: 'this challenge is unknown, already spent, or past its deadline; ask for a new one',
      };
    }
    const verdict = await verifyTunnelRequest(
      crypto,
      {
        action,
        daemonId: request.daemonId,
        host,
        nonce: fromBase64Url(request.nonce) ?? new Uint8Array(0),
        ...(originPort === undefined ? {} : { originPort }),
      },
      request,
    );
    if (!verdict.ok) return { ok: false, code: 'tunnel_claim_rejected', message: verdict.reason };
    return { ok: true, value: null };
  }

  /**
   * Walk the pool in its declared order and write a fresh row on the first account that can take it.
   * An account whose zone was never checked (or whose verdict went stale) is checked here, and the
   * verdict is kept either way.
   */
  private async place(
    pool: Extract<TunnelPoolState, { kind: 'ready' }>,
    daemonId: string,
    originPort: number,
  ): Promise<TunnelOutcome<{ readonly row: TunnelRow; readonly account: TunnelAccount }>> {
    const { store, api, crypto } = this.dependencies;
    const now = this.dependencies.now();
    const verdicts = await store.zoneVerdicts();
    const standings: TunnelAccountStanding[] = [];
    const unreachable: string[] = [];
    for (const account of pool.accounts) {
      const live = account.accepting ? await store.countOnAccount(account.accountId, account.maxTunnels) : 0;
      let standing = tunnelAccountStanding(
        account,
        live,
        tunnelZoneCheck(account, verdicts.get(account.accountId) ?? null, now),
      );
      if (standing === 'needs-zone-check') {
        const zone = await api.zone(account);
        if (!zone.ok && zone.kind === 'failed') {
          unreachable.push(`${account.name}: zone check: ${zone.reason}`);
          continue;
        }
        const passed = zone.ok && tunnelZoneMatches(account, zone.value);
        await store.saveZoneVerdict({
          accountId: account.accountId,
          zoneId: account.zoneId,
          zone: account.zone,
          passed,
          checkedAt: now,
        });
        standing = passed ? 'eligible' : 'misconfigured';
      }
      standings.push(standing);
      if (standing !== 'eligible') continue;
      const label = tunnelLabel(crypto.randomBytes(TUNNEL_LABEL_BYTES));
      const row: TunnelRow = {
        label,
        daemonId,
        account: account.name,
        accountId: account.accountId,
        hostname: `${label}.${account.zone}`,
        tunnelId: null,
        configuredPort: null,
        dnsRecordId: null,
        originPort,
        createdAt: now,
        lastSeenAt: now,
      };
      await store.saveActive(row);
      return { ok: true, value: { row, account } };
    }
    if (unreachable.length > 0) return upstreamFailed(unreachable.join('; '));
    const code = tunnelPlacementRefusal(standings);
    return code === 'tunnel_capacity'
      ? { ok: false, code, message: 'every tunnel account that is accepting is at its limit' }
      : unavailable();
  }

  /** Make every missing upstream piece, recording each one before the next is asked for. */
  private async finish(row: TunnelRow, account: TunnelAccount): Promise<Upstream<TunnelRow>> {
    const { store, api } = this.dependencies;
    let current = row;
    if (current.tunnelId === null) {
      const found = await api.findTunnel(account, tunnelName(current.label));
      if (!found.ok) return failedStep('look up the tunnel', found.reason);
      let tunnelId = found.value?.id;
      if (tunnelId === undefined) {
        const created = await api.createTunnel(account, tunnelName(current.label));
        if (!created.ok) return failedStep('create the tunnel', created.reason);
        tunnelId = created.value.id;
      }
      current = { ...current, tunnelId };
      await store.saveActive(current);
    }
    const tunnelId = current.tunnelId as string;
    if (current.configuredPort !== current.originPort) {
      const configured = await api.configureTunnel(
        account,
        tunnelId,
        tunnelIngress(current.hostname, current.daemonId, current.originPort),
      );
      if (!configured.ok) return failedStep('write the ingress', configured.reason);
      current = { ...current, configuredPort: current.originPort };
      await store.saveActive(current);
    }
    if (current.dnsRecordId === null) {
      const found = await api.findDnsRecord(account, current.hostname);
      if (!found.ok) return failedStep('look up the DNS record', found.reason);
      let recordId = found.value?.id;
      if (recordId === undefined) {
        const created = await api.createDnsRecord(account, current.hostname, tunnelCnameTarget(tunnelId));
        if (!created.ok) return failedStep('create the DNS record', created.reason);
        recordId = created.value.id;
      }
      current = { ...current, dnsRecordId: recordId };
      await store.saveActive(current);
    }
    return { ok: true, value: current };
  }

  /**
   * Delete one retired tunnel: clean up its connections (a tunnel with live connections refuses to be
   * deleted), delete it, then delete its DNS record (deleting a tunnel leaves its record behind). "Not
   * found" is done. The row is forgotten only once all three have succeeded.
   */
  private async delete(row: TunnelRow, account: TunnelAccount): Promise<Upstream<null>> {
    const { store, api } = this.dependencies;
    let current = row;
    if (current.tunnelId === null) {
      const found = await api.findTunnel(account, tunnelName(current.label));
      if (!found.ok) return failedStep('look up the tunnel', found.reason);
      if (found.value !== null) {
        current = { ...current, tunnelId: found.value.id };
        await store.saveRetired(current);
      }
    }
    if (current.tunnelId !== null) {
      const cleaned = await api.cleanupConnections(account, current.tunnelId);
      if (!cleaned.ok && cleaned.kind !== 'not_found') return failedStep('clean up connections', cleaned.reason);
      const deleted = await api.deleteTunnel(account, current.tunnelId);
      if (!deleted.ok && deleted.kind !== 'not_found') return failedStep('delete the tunnel', deleted.reason);
    }
    let recordId = current.dnsRecordId;
    if (recordId === null) {
      const found = await api.findDnsRecord(account, current.hostname);
      if (!found.ok) return failedStep('look up the DNS record', found.reason);
      recordId = found.value?.id ?? null;
    }
    if (recordId !== null) {
      const removed = await api.deleteDnsRecord(account, recordId);
      if (!removed.ok && removed.kind !== 'not_found') return failedStep('delete the DNS record', removed.reason);
    }
    await store.forget(current);
    return { ok: true, value: null };
  }

  /** Every row of one kind, page by page; `onDamaged` hears how many rows each page skipped. */
  private async *rows(kind: 'active' | 'retired', onDamaged?: (count: number) => void): AsyncGenerator<TunnelRow> {
    const { store } = this.dependencies;
    let after: string | null = null;
    do {
      const page: TunnelRowPage =
        kind === 'active' ? await store.activeRows(after, PAGE_SIZE) : await store.retiredRows(after, PAGE_SIZE);
      onDamaged?.(page.damaged);
      yield* page.rows;
      after = page.next;
    } while (after !== null);
  }
}

function unavailable(): { readonly ok: false; readonly code: TunnelRefusalCode; readonly message: string } {
  return { ok: false, code: 'tunnel_unavailable', message: 'the hosted tunnel service is not set up by its operator' };
}

function upstreamFailed(detail: string): TunnelOutcome<never> {
  return {
    ok: false,
    code: 'tunnel_upstream_failed',
    message: 'Cloudflare did not complete the tunnel; try again later',
    detail,
  };
}

function failedStep(step: string, reason: string): { readonly ok: false; readonly detail: string } {
  return { ok: false, detail: `${step}: ${reason}` };
}
