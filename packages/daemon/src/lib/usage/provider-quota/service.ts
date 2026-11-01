/**
 * Environment logins' quotas, read only while somebody is watching (docs/provider-quotas.md).
 *
 * ## When a read happens
 *
 * - **Only on demand.** {@link ProviderQuotaService.watch} is called by a screen being read (the logins
 *   list, the usage feed a composer chip or Info › Usage polls) and by the Warden
 *   when they ask the usage feed. Nothing here owns a timer, and the daemon's unattended refresh pass
 *   reads {@link ProviderQuotaService.peek} — the cache — and nothing else.
 * - **At most once a minute per login**, whatever the number of watchers: an attempt, answered or not,
 *   is not repeated for {@link PROVIDER_QUOTA_MIN_INTERVAL_MS}, and concurrent watchers share one read.
 * - **Never inference.** A quota, balance or key-info endpoint answers about the account; nothing here
 *   sends a prompt.
 *
 * ## In which order
 *
 * 1. The provider's own endpoint, through the outbound holder (the key is never held here).
 * 2. This daemon's transcripts × known pricing: what its own sessions on the login cost this month.
 * 3. "Usage unknown", with the reason. Never a 0 that nobody measured.
 *
 * Rate-limit headers on a ferret's own requests would sit between 1 and 2; the CLI talks to its
 * provider directly, so the daemon never sees them. That is a declared gap.
 */
import type { ProviderQuotaReading, ProviderQuotaSpend } from '@ferretry/protocol';
import type { AuthorizedOutcome, OutboundAuthorizerPort } from '../../speedups/ports.ts';
import type { ParsedProviderQuota, ProviderQuotaParse } from './parse.ts';
import {
  hasQuotaEndpoint,
  type ProviderQuotaLogin,
  planProviderQuota,
  presetQuotaSource,
  presetQuotaUnverified,
} from './plan.ts';

/** The fewest milliseconds between two reads of one login's quota. */
export const PROVIDER_QUOTA_MIN_INTERVAL_MS = 60_000;

/** What this daemon's own transcripts say one login's sessions cost. */
export interface TranscriptSpend {
  /** Equivalent cost of the priced sessions, in millionths of a US dollar. */
  readonly usdMicros: number;
  readonly sessions: number;
  /** Sessions with no price for their model. */
  readonly unpriced: number;
}

/** Equivalent cost from the analytics index, for the sessions that ran on these runtimes since then. */
export interface TranscriptSpendPort {
  spend(agents: readonly string[], sinceMs: number): Promise<TranscriptSpend | undefined>;
}

export interface ProviderQuotaDeps {
  /** Every environment login on this machine, with its preset and the runtimes on it. */
  logins(): Promise<readonly ProviderQuotaLogin[]>;
  /** The outbound holder (docs/secrets.md): puts the named key on one request and returns the reply. */
  readonly authorizer: Pick<OutboundAuthorizerPort, 'send'>;
  readonly spend?: TranscriptSpendPort;
  readonly clock: { nowMs(): number };
}

interface CacheEntry {
  readonly reading: ProviderQuotaReading;
  readonly attemptedAt: number;
}

/** The fixed sentence for each way an endpoint read can fail to produce a quota. */
export const PROVIDER_QUOTA_NOTES = {
  local: 'A local model has no quota and no bill.',
  nothingPriced: 'This provider has no quota endpoint, and no session on this login has been priced yet.',
  rejected: 'The provider refused this login’s key, so its quota could not be read.',
  missing: 'A secret this login needs is not in the secret store, so its quota could not be read.',
  unanswered: 'The provider’s quota endpoint did not answer, so its quota could not be read.',
  unreadable: 'The provider answered its quota endpoint with something Ferretry cannot read.',
} as const;

/** The first instant of this UTC calendar month. */
export const monthStartMs = (nowMs: number): number => {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
};

/** What an endpoint outcome means for the reading: a quota, or why there is none. */
function outcomeOf(
  outcome: AuthorizedOutcome,
  parse: (payload: unknown, nowMs: number) => ProviderQuotaParse,
  nowMs: number,
): { readonly quota: ParsedProviderQuota } | { readonly note: string; readonly transient: boolean } {
  switch (outcome.kind) {
    case 'completion': {
      const parsed = parse(outcome.payload, nowMs);
      if (parsed.kind === 'quota') return { quota: parsed.quota };
      if (parsed.kind === 'rejected') return { note: PROVIDER_QUOTA_NOTES.rejected, transient: false };
      return { note: PROVIDER_QUOTA_NOTES.unreadable, transient: true };
    }
    case 'secret_missing':
      return { note: PROVIDER_QUOTA_NOTES.missing, transient: false };
    case 'status':
      return outcome.status === 401 || outcome.status === 403
        ? { note: PROVIDER_QUOTA_NOTES.rejected, transient: false }
        : { note: PROVIDER_QUOTA_NOTES.unanswered, transient: true };
    case 'oversized':
    case 'unreadable':
      return { note: PROVIDER_QUOTA_NOTES.unreadable, transient: true };
    default:
      return { note: PROVIDER_QUOTA_NOTES.unanswered, transient: true };
  }
}

export class ProviderQuotaService {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #pending = new Map<string, Promise<void>>();
  /** Each runtime executable's login, as of the last watch. */
  #byAgent: ReadonlyMap<string, string> = new Map();

  constructor(private readonly deps: ProviderQuotaDeps) {}

  /** The last reading of one login, or `undefined` when nobody has watched it yet. Never reads. */
  peek(id: string): ProviderQuotaReading | undefined {
    return this.#cache.get(id)?.reading;
  }

  /** The last reading of the login a runtime executable is on. Never reads. */
  peekAgent(agent: string): ProviderQuotaReading | undefined {
    const id = this.#byAgent.get(agent);
    return id === undefined ? undefined : this.peek(id);
  }

  /**
   * Somebody is looking: read every environment login whose last attempt is a minute old or more.
   * Never rejects; a login that could not be read keeps its last reading or says why.
   */
  async watch(): Promise<void> {
    let logins: readonly ProviderQuotaLogin[];
    try {
      logins = await this.deps.logins();
    } catch {
      return;
    }
    this.#byAgent = new Map(logins.flatMap(login => login.agents.map(agent => [agent, login.id] as const)));
    await Promise.allSettled(logins.map(async login => await this.#due(login)));
  }

  /** One shared read per login, and none within a minute of the last attempt. */
  async #due(login: ProviderQuotaLogin): Promise<void> {
    const last = this.#cache.get(login.id);
    if (last !== undefined && this.deps.clock.nowMs() - last.attemptedAt < PROVIDER_QUOTA_MIN_INTERVAL_MS) return;
    const pending = this.#pending.get(login.id);
    if (pending !== undefined) return await pending;
    const read = this.#read(login, last).finally(() => this.#pending.delete(login.id));
    this.#pending.set(login.id, read);
    await read;
  }

  async #read(login: ProviderQuotaLogin, last: CacheEntry | undefined): Promise<void> {
    const attemptedAt = this.deps.clock.nowMs();
    const source = presetQuotaSource(login.preset);
    const unverifiedPreset = presetQuotaUnverified(login.preset);
    const stamp = (
      via: ProviderQuotaReading['via'],
      fields: Partial<
        Pick<ProviderQuotaReading, 'windows' | 'balance' | 'spend' | 'exhausted' | 'note' | 'unverified'>
      >,
    ): ProviderQuotaReading => ({
      source,
      via,
      windows: fields.windows ?? [],
      ...(fields.balance === undefined ? {} : { balance: fields.balance }),
      ...(fields.spend === undefined ? {} : { spend: fields.spend }),
      exhausted: fields.exhausted ?? false,
      unverified: (fields.unverified ?? false) || unverifiedPreset,
      ...(fields.note === undefined ? {} : { note: fields.note }),
      at: new Date(this.deps.clock.nowMs()).toISOString(),
    });
    const settle = (reading: ProviderQuotaReading): void => {
      this.#cache.set(login.id, { reading, attemptedAt });
    };

    if (source === 'none') return settle(stamp('unknown', { note: PROVIDER_QUOTA_NOTES.local }));

    let failure: string | undefined;
    if (hasQuotaEndpoint(source)) {
      const plan = planProviderQuota(login);
      if ('reason' in plan) {
        failure = plan.reason;
      } else {
        const outcome = await this.deps.authorizer
          .send(plan.secretName, plan.hosts, plan.request, plan.placement)
          .catch((): AuthorizedOutcome => ({ kind: 'unreachable' }));
        const result = outcomeOf(outcome, plan.parse, this.deps.clock.nowMs());
        if ('quota' in result) {
          return settle(stamp('endpoint', { ...result.quota, unverified: plan.unverified }));
        }
        // A blip does not erase what the provider said a minute ago: the last endpoint reading stays,
        // with its own `at`, until the provider answers again or refuses the key.
        if (result.transient && last?.reading.via === 'endpoint') return settle(last.reading);
        failure = result.note;
      }
    }

    const spend = await this.#spend(login, attemptedAt);
    if (spend !== undefined) {
      return settle(stamp('transcript', { spend, ...(failure === undefined ? {} : { note: failure }) }));
    }
    return settle(stamp('unknown', { note: failure ?? PROVIDER_QUOTA_NOTES.nothingPriced }));
  }

  /** This month's equivalent cost from the transcripts, when at least one session was priced. */
  async #spend(login: ProviderQuotaLogin, nowMs: number): Promise<ProviderQuotaSpend | undefined> {
    if (this.deps.spend === undefined || login.agents.length === 0) return undefined;
    const since = monthStartMs(nowMs);
    const counted = await this.deps.spend.spend(login.agents, since).catch(() => undefined);
    if (counted === undefined || counted.sessions === counted.unpriced) return undefined;
    return {
      amountUsd: counted.usdMicros / 1_000_000,
      since: new Date(since).toISOString(),
      sessions: counted.sessions,
      unpriced: counted.unpriced,
    };
  }
}
