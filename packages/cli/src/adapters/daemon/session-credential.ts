import type { IFyApiClient, IFyHttpTransport } from '@ferretry/protocol';
import { z } from 'zod';
import { type DaemonInstanceFacts, mayFallBackAfterRefusal } from '../../lib/daemon/credential.ts';

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
