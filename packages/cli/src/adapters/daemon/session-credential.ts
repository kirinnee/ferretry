import type { IFyApiClient, IFyHttpTransport } from '@ferretry/protocol';
import { z } from 'zod';
import {
  type DaemonInstanceFacts,
  mayFallBackAfterRefusal,
  presentsSessionBearer,
} from '../../lib/daemon/credential.ts';

/**
 * The two facts of `/v1/health` the credential choice reads. Not the full `HealthViewSchema`: a newer
 * or older daemon's report must not stop a ferret's `fy` from deciding which credential to present.
 */
const InstanceHealthSchema = z.object({
  pid: z.number().int().optional(),
  features: z.array(z.string()).optional(),
});

/** One read of a daemon's public health route. */
export interface IDaemonInstanceReader {
  read(baseUrl: string): Promise<DaemonInstanceFacts>;
}

/**
 * Reads `/v1/health` with no credential. It is a public route, and its feature list is decided by how the
 * request ARRIVED (the daemon offers `session.credential.1` only where a session bearer would resolve), so
 * nothing here is worth a credential and none is risked.
 */
export class HealthInstanceReader implements IDaemonInstanceReader {
  constructor(private readonly connect: (baseUrl: string) => Promise<Pick<IFyApiClient, 'request'>>) {}

  async read(baseUrl: string): Promise<DaemonInstanceFacts> {
    const health = await (await this.connect(baseUrl)).request('/v1/health', InstanceHealthSchema);
    return { pid: health.pid, features: health.features ?? [] };
  }
}

/**
 * What each daemon said, ONCE PER URL PER PROCESS, and tied to the instance that said it: the answer
 * carries the daemon's pid, and {@link refresh} replaces it with what the daemon at that URL says now.
 *
 * A failed read is not remembered, so the next connection asks again rather than inheriting an outage.
 */
export class DaemonInstanceCache {
  readonly #known = new Map<string, Promise<DaemonInstanceFacts>>();

  constructor(private readonly reader: IDaemonInstanceReader) {}

  facts(baseUrl: string): Promise<DaemonInstanceFacts> {
    const known = this.#known.get(baseUrl);
    return known ?? this.refresh(baseUrl);
  }

  refresh(baseUrl: string): Promise<DaemonInstanceFacts> {
    const reading = this.reader.read(baseUrl);
    this.#known.set(baseUrl, reading);
    reading.catch(() => {
      if (this.#known.get(baseUrl) === reading) this.#known.delete(baseUrl);
    });
    return reading;
  }
}

/** What the transport needs to decide, after a `401`, whether this daemon has stopped taking the bearer. */
export interface SessionBearerFallback {
  /** A fresh `/v1/health` read of the daemon that answered. */
  readonly reread: () => Promise<DaemonInstanceFacts>;
  /** The host's admin token: opened ONLY once {@link mayFallBackAfterRefusal} said yes. */
  readonly adminToken: () => Promise<string>;
  /** Told, on stderr, when the bearer was swapped for the admin token. */
  readonly note?: (line: string) => void;
}

/**
 * The ferret's own credential on the wire, and the one narrow way off it.
 *
 * Every request leaves with `Authorization: Bearer fys_…`. An answer other than `401` is returned as it
 * is — `403 owner_only`, `404`, `5xx` included — because a daemon that took the bearer at connect time
 * has said this is its answer (plan §9.1). A `401` gets ONE fresh `/v1/health` read: only if that daemon
 * no longer offers `session.credential.1` (a restart onto a wildcard bind, a downgrade) is the same
 * request sent once more with the admin token. Anything else, the read failing included, returns the
 * `401` as the answer. A spine `401` ran nothing, so the second send cannot apply a request twice.
 *
 * Never remembered: each `401` asks the daemon again, so a daemon that offers the credential again after
 * a later restart is never answered with the admin token.
 */
export class SessionBearerTransport implements IFyHttpTransport {
  constructor(
    private readonly inner: IFyHttpTransport,
    private readonly bearer: string,
    private readonly fallback: SessionBearerFallback,
  ) {}

  async send(url: string, init: RequestInit): Promise<Response> {
    const response = await this.inner.send(url, init);
    if (response.status !== 401) return response;
    const headers = new Headers(init.headers);
    // Only a request this credential carried: the transport never re-sends somebody else's.
    if (headers.get('authorization') !== `Bearer ${this.bearer}`) return response;
    let admin: string;
    try {
      if (!mayFallBackAfterRefusal(response.status, await this.fallback.reread())) return response;
      admin = await this.fallback.adminToken();
    } catch {
      return response;
    }
    this.fallback.note?.(
      'the daemon no longer takes this ferret’s own credential (it does not offer session.credential.1); using the admin token',
    );
    headers.set('authorization', `Bearer ${admin}`);
    return await this.inner.send(url, { ...init, headers });
  }
}

/** A client decided once, and whether a ferret's own credential may yet replace it. */
export interface DecidedConnection<C> {
  readonly client: C;
  /**
   * Present when a ferret's credential was set aside because the daemon did not offer it: the daemon to ask
   * again, and the instance (pid) that said no.
   */
  readonly revisit?: { readonly baseUrl: string; readonly pid: number | undefined };
}

/** How long a long-lived process trusts a daemon's "I do not take session credentials" before asking again. */
const SESSION_REVISIT_MS = 30_000;

/**
 * The connection a long-lived process (`fy mcp serve`) holds, decided on first use.
 *
 * A ferret's process that was answered "no `session.credential.1`" — a wildcard bind, a daemon mid-upgrade —
 * is NOT held on the admin token for its whole life. At most every {@link SESSION_REVISIT_MS}, before a
 * request, the daemon's health is read again: a daemon that now offers the credential, or a different
 * instance at that URL (another pid), gets a fresh decision, so the bearer is picked up after an upgrade
 * without the pane restarting. The same instance still saying no keeps the client it has. A failed read
 * keeps it too: there is no bearer to switch to until a daemon offers one.
 *
 * A DECISION THAT FAILED IS NEVER KEPT. A first decision, or a fresh one after a look, that rejects (the
 * daemon away, the listener check or the `api-token` read throwing) fails the call that asked and is then
 * forgotten, so the next call decides again from the start rather than repeating the old failure for the
 * life of the process. Deciding again is the same `decide`: it can reach nothing the first one could not.
 */
export class RevisitedConnection<C> {
  #held: Promise<DecidedConnection<C>> | undefined;
  #checkedAt = 0;

  constructor(
    private readonly decide: () => Promise<DecidedConnection<C>>,
    private readonly reread: (baseUrl: string) => Promise<DaemonInstanceFacts>,
    private readonly nowMs: () => number,
    private readonly everyMs: number = SESSION_REVISIT_MS,
  ) {}

  async client(): Promise<C> {
    if (this.#held === undefined) {
      this.#held = this.#decided();
      this.#checkedAt = this.nowMs();
    }
    const held = await this.#held;
    const revisit = held.revisit;
    if (revisit === undefined || this.nowMs() - this.#checkedAt < this.everyMs) return held.client;
    this.#checkedAt = this.nowMs();
    let fresh: DaemonInstanceFacts;
    try {
      fresh = await this.reread(revisit.baseUrl);
    } catch {
      return held.client;
    }
    if (!presentsSessionBearer(fresh) && fresh.pid === revisit.pid) return held.client;
    const next = this.#decided();
    this.#held = next;
    return (await next).client;
  }

  /** A fresh decision, held until it fails: a rejected one is dropped, if still held, so the next call decides again. */
  #decided(): Promise<DecidedConnection<C>> {
    const decision: Promise<DecidedConnection<C>> = this.decide().catch((error: unknown) => {
      if (this.#held === decision) this.#held = undefined;
      throw error;
    });
    return decision;
  }
}
