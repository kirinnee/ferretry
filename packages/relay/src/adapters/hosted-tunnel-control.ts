/**
 * Cloudflare Durable Object adapter for the hosted tunnel provisioner — `docs/relay-protocol.md` §15.
 *
 * ONE globally named object (`TUNNEL_CONTROL`, separate from the relay's meter) holds every tunnel row,
 * the outstanding challenge nonces, the cached zone verdicts and the operator's tunnel settings. It is
 * thin on purpose: it serialises requests, adapts Durable Object storage to the {@link TunnelStore} port,
 * reads the pool from the Worker secret, and runs the reclaim on its alarm. Every decision is
 * `TunnelProvisioner`'s.
 *
 * WHY ONE CALL AT A TIME. A Durable Object is single-threaded, but every Cloudflare API call is an
 * `await` that lets the next request in. Two provisions for one daemon interleaving there would each
 * place a tunnel, and two for different daemons would both read an account as having room. Requests are
 * therefore chained, as the rendezvous object chains its frames. Provisioning is rare — a renewal a day
 * per daemon — so one queue costs nothing worth measuring.
 *
 * WHAT IS NEVER STORED: a connector token. The provisioner reads it from Cloudflare on every provision
 * and hands it straight to the daemon, so this object holds no credential a storage read could leak.
 * The pool's API tokens live only in the Worker secret.
 */

import { z } from 'zod';
import {
  type CloudflareTunnelApi,
  DEFAULT_TUNNEL_SETTINGS,
  parseTunnelAccountPool,
  type RelayCrypto,
  TUNNEL_DAY_MILLISECONDS,
  TunnelChallengeBookSchema,
  TunnelChallengeRequestSchema,
  type TunnelOutcome,
  type TunnelPoolState,
  TunnelProvisioner,
  TunnelProvisionRequestSchema,
  type TunnelRefusalCode,
  TunnelReleaseRequestSchema,
  type TunnelRow,
  type TunnelRowPage,
  TunnelRowSchema,
  TunnelSettingsSchema,
  TunnelStateDamagedError,
  type TunnelStore,
  type TunnelZoneVerdict,
  TunnelZoneVerdictSchema,
  tunnelRefusalStatus,
} from '../lib/index.ts';
import { CloudflareFetchTunnelApi } from './cloudflare-tunnel-api.ts';
import type { HostedRelayControlNamespace, HostedRelayControlStorage } from './hosted-control.ts';
import { WebCryptoRelayCrypto } from './webcrypto-relay-crypto.ts';

export const HOSTED_TUNNEL_CONTROL_OBJECT_NAME = 'ferretry-tunnel-control/v1' as const;

/** When the alarm comes back after a pass that stopped at its deletion budget. */
export const TUNNEL_RECLAIM_CONTINUE_MS = 60_000;

const ACTIVE_PREFIX = 'tunnel:active:';
const RETIRED_PREFIX = 'tunnel:retired:';
const INDEX_PREFIX = 'tunnel:index:';
const ZONE_PREFIX = 'tunnel:zone:';
const CHALLENGES_KEY = 'tunnel:challenges';
const SETTINGS_KEY = 'tunnel:settings';
const LIST_PAGE_SIZE = 1_000;

/** The internal routes the Worker forwards to. Never reachable from outside: the Worker owns the URL space. */
export const TUNNEL_CONTROL_ROUTES = {
  service: '/service',
  challenge: '/challenge',
  provision: '/provision',
  release: '/release',
  status: '/operator/status',
  settings: '/operator/settings',
} as const;

/** What the Worker sends for a signed request: the body it parsed, and the host it is serving. */
const SignedEnvelopeSchema = <T extends z.ZodType>(request: T) =>
  z.strictObject({ host: z.string().min(1).max(260), request });

export interface HostedTunnelControlStorage extends HostedRelayControlStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface HostedTunnelControlObjectState {
  readonly storage: HostedTunnelControlStorage;
}

export interface HostedTunnelControlEnvironment {
  /** The pool: a JSON array of `TunnelAccountSchema`. A Worker secret, never a var. */
  readonly TUNNEL_ACCOUNTS?: string;
}

export interface HostedTunnelControlRuntime {
  readonly crypto: RelayCrypto;
  readonly cloudflare: CloudflareTunnelApi;
  now(): number;
  /** Operator-facing log lines. Nothing passed here ever contains a token. */
  log(message: string): void;
}

export const hostedTunnelControlRuntime: HostedTunnelControlRuntime = {
  crypto: new WebCryptoRelayCrypto(),
  cloudflare: new CloudflareFetchTunnelApi(),
  now: () => Date.now(),
  log: message => console.error(message),
};

/** The named stub the Worker uses; there is exactly one tunnel control object per deployment. */
export function hostedTunnelControlStub(namespace: HostedRelayControlNamespace) {
  return namespace.get(namespace.idFromName(HOSTED_TUNNEL_CONTROL_OBJECT_NAME));
}

export class HostedTunnelControlDurableObject {
  private readonly provisioner: TunnelProvisioner;
  private queue: Promise<unknown> = Promise.resolve();
  /** The last pool text this instance reported as invalid, so a bad secret is logged once, not per request. */
  private reportedPool: string | undefined;

  constructor(
    private readonly objectState: HostedTunnelControlObjectState,
    private readonly environment: HostedTunnelControlEnvironment,
    private readonly runtime: HostedTunnelControlRuntime = hostedTunnelControlRuntime,
  ) {
    this.provisioner = new TunnelProvisioner({
      api: runtime.cloudflare,
      store: new DurableTunnelStore(objectState.storage),
      crypto: runtime.crypto,
      now: () => runtime.now(),
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.serialised(async () => {
      try {
        await this.ensureAlarm();
        return await this.route(request);
      } catch (error) {
        this.runtime.log(`tunnel control failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        const message =
          error instanceof TunnelStateDamagedError
            ? 'the tunnel service state is damaged; its operator has been told'
            : 'the tunnel service failed unexpectedly';
        return refusal('tunnel_unavailable', message);
      }
    });
  }

  /** The daily reclaim. A pass that hit its deletion budget comes back in a minute for the rest. */
  alarm(): Promise<void> {
    return this.serialised(async () => {
      let continueSoon = false;
      try {
        const report = await this.provisioner.reclaim(this.pool());
        continueSoon = report.more;
        if (report.retired + report.deleted + report.failed > 0 || report.orphaned > 0) {
          this.runtime.log(
            `tunnel reclaim: retired ${report.retired}, deleted ${report.deleted}, failed ${report.failed}, ` +
              `orphaned ${report.orphaned}${report.more ? ', continuing' : ''}`,
          );
        }
        for (const problem of report.problems) this.runtime.log(`tunnel reclaim step failed: ${problem}`);
      } catch (error) {
        this.runtime.log(`tunnel reclaim failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      const delay = continueSoon ? TUNNEL_RECLAIM_CONTINUE_MS : TUNNEL_DAY_MILLISECONDS;
      await this.objectState.storage.setAlarm(this.runtime.now() + delay);
    });
  }

  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const pool = this.pool();
    if (request.method === 'GET' && path === TUNNEL_CONTROL_ROUTES.service) {
      return json(await this.provisioner.advertise(pool), 200);
    }
    if (request.method === 'GET' && path === TUNNEL_CONTROL_ROUTES.status) {
      return json(await this.provisioner.status(pool), 200);
    }
    if (request.method === 'PUT' && path === TUNNEL_CONTROL_ROUTES.settings) {
      const settings = await parsedBody(request, TunnelSettingsSchema);
      if (settings === null) return refusal('tunnel_bad_request', 'invalid tunnel settings');
      return json({ settings: await this.provisioner.configure(settings) }, 200);
    }
    if (request.method === 'POST' && path === TUNNEL_CONTROL_ROUTES.challenge) {
      const body = await parsedBody(request, TunnelChallengeRequestSchema);
      if (body === null) return refusal('tunnel_bad_request', 'invalid challenge request');
      return answer(await this.provisioner.challenge(pool, body));
    }
    if (request.method === 'POST' && path === TUNNEL_CONTROL_ROUTES.provision) {
      const body = await parsedBody(request, SignedEnvelopeSchema(TunnelProvisionRequestSchema));
      if (body === null) return refusal('tunnel_bad_request', 'invalid provision request');
      return this.answerLogged(await this.provisioner.provision(pool, body.host, body.request));
    }
    if (request.method === 'POST' && path === TUNNEL_CONTROL_ROUTES.release) {
      const body = await parsedBody(request, SignedEnvelopeSchema(TunnelReleaseRequestSchema));
      if (body === null) return refusal('tunnel_bad_request', 'invalid release request');
      const outcome = await this.provisioner.release(pool, body.host, body.request);
      if (!outcome.ok) return answer(outcome);
      const { problem, ...release } = outcome.value;
      if (problem !== undefined) this.runtime.log(`tunnel release left work for the reclaim: ${problem}`);
      return json(release, 200);
    }
    return new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  private answerLogged<T>(outcome: TunnelOutcome<T>): Response {
    if (!outcome.ok && outcome.detail !== undefined) this.runtime.log(`tunnel provision failed: ${outcome.detail}`);
    return answer(outcome);
  }

  /** The pool, re-read on every call so a reinstalled secret applies to the next request. */
  private pool(): TunnelPoolState {
    const raw = this.environment.TUNNEL_ACCOUNTS;
    const pool = parseTunnelAccountPool(raw);
    if (pool.kind === 'invalid' && this.reportedPool !== raw) {
      this.reportedPool = raw;
      this.runtime.log(`tunnel pool is unusable, so the tunnel service is off: ${pool.reason}`);
    }
    return pool;
  }

  private async ensureAlarm(): Promise<void> {
    const storage = this.objectState.storage;
    if ((await storage.getAlarm()) === null) await storage.setAlarm(this.runtime.now() + TUNNEL_DAY_MILLISECONDS);
  }

  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** {@link TunnelStore} over Durable Object storage. Multi-key writes are transactions. */
export class DurableTunnelStore implements TunnelStore {
  constructor(private readonly storage: HostedRelayControlStorage) {}

  async activeRow(daemonId: string): Promise<TunnelRow | null> {
    const raw = await this.storage.get(`${ACTIVE_PREFIX}${daemonId}`);
    if (raw === undefined) return null;
    const parsed = TunnelRowSchema.safeParse(raw);
    if (!parsed.success || parsed.data.daemonId !== daemonId) {
      throw new TunnelStateDamagedError(`the active tunnel row for ${daemonId}`);
    }
    return parsed.data;
  }

  saveActive(row: TunnelRow): Promise<void> {
    return this.storage.transaction(async transaction => {
      await transaction.put(`${ACTIVE_PREFIX}${row.daemonId}`, row);
      await transaction.put(indexKey(row), 1);
    });
  }

  retire(row: TunnelRow): Promise<void> {
    return this.storage.transaction(async transaction => {
      await transaction.delete(`${ACTIVE_PREFIX}${row.daemonId}`);
      await transaction.put(`${RETIRED_PREFIX}${row.label}`, row);
      await transaction.put(indexKey(row), 1);
    });
  }

  saveRetired(row: TunnelRow): Promise<void> {
    return this.storage.put(`${RETIRED_PREFIX}${row.label}`, row);
  }

  forget(row: TunnelRow): Promise<void> {
    return this.storage.transaction(async transaction => {
      await transaction.delete(`${RETIRED_PREFIX}${row.label}`);
      await transaction.delete(indexKey(row));
    });
  }

  activeRows(after: string | null, limit: number): Promise<TunnelRowPage> {
    return this.page(ACTIVE_PREFIX, after, limit);
  }

  retiredRows(after: string | null, limit: number): Promise<TunnelRowPage> {
    return this.page(RETIRED_PREFIX, after, limit);
  }

  async countOnAccount(accountId: string, limit: number): Promise<number> {
    return (await this.storage.list({ prefix: `${INDEX_PREFIX}${accountId}:`, limit })).size;
  }

  async zoneVerdicts(): Promise<ReadonlyMap<string, TunnelZoneVerdict>> {
    const verdicts = new Map<string, TunnelZoneVerdict>();
    const page = await this.storage.list<unknown>({ prefix: ZONE_PREFIX, limit: LIST_PAGE_SIZE });
    for (const raw of page.values()) {
      const parsed = TunnelZoneVerdictSchema.safeParse(raw);
      // An unreadable verdict is an unchecked zone: the next placement checks it again.
      if (parsed.success) verdicts.set(parsed.data.accountId, parsed.data);
    }
    return verdicts;
  }

  saveZoneVerdict(verdict: TunnelZoneVerdict): Promise<void> {
    return this.storage.put(`${ZONE_PREFIX}${verdict.accountId}`, verdict);
  }

  /** An unreadable book is an empty one: every nonce in it becomes unknown, which only refuses. */
  async challengeBook() {
    const parsed = TunnelChallengeBookSchema.safeParse(await this.storage.get(CHALLENGES_KEY));
    return parsed.success ? parsed.data : [];
  }

  saveChallengeBook(book: z.infer<typeof TunnelChallengeBookSchema>): Promise<void> {
    return this.storage.put(CHALLENGES_KEY, book);
  }

  async settings() {
    const parsed = TunnelSettingsSchema.safeParse(await this.storage.get(SETTINGS_KEY));
    return parsed.success ? parsed.data : DEFAULT_TUNNEL_SETTINGS;
  }

  saveSettings(settings: z.infer<typeof TunnelSettingsSchema>): Promise<void> {
    return this.storage.put(SETTINGS_KEY, settings);
  }

  private async page(prefix: string, after: string | null, limit: number): Promise<TunnelRowPage> {
    const entries = await this.storage.list<unknown>({
      prefix,
      limit,
      ...(after === null ? {} : { startAfter: after }),
    });
    const rows: TunnelRow[] = [];
    let damaged = 0;
    for (const raw of entries.values()) {
      const parsed = TunnelRowSchema.safeParse(raw);
      if (parsed.success) rows.push(parsed.data);
      else damaged += 1;
    }
    return { rows, damaged, next: entries.size < limit ? null : ([...entries.keys()].at(-1) ?? null) };
  }
}

function indexKey(row: TunnelRow): string {
  return `${INDEX_PREFIX}${row.accountId}:${row.label}`;
}

async function parsedBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T> | null> {
  try {
    const parsed = schema.safeParse(await request.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function answer<T>(outcome: TunnelOutcome<T>): Response {
  return outcome.ok ? json(outcome.value, 200) : refusal(outcome.code, outcome.message);
}

/** A typed refusal, `{ error: { code, message } }`, with the status every surface agrees on. */
export function refusal(code: TunnelRefusalCode, message: string): Response {
  return json({ error: { code, message } }, tunnelRefusalStatus(code));
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' },
  });
}
