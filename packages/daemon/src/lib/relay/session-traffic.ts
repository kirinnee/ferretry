/** Bounded, log-only counters. Route names come exclusively from the daemon's existing router. */
export const MAX_SESSION_ROUTE_TEMPLATES = 32;

interface RouteTraffic {
  readonly route: string;
  readonly answers: number;
  /** Bytes actually sent, after gzip/base64, including the sealed record's envelope and tag. */
  readonly bytes: number;
}

export interface SessionTrafficSnapshot {
  readonly routes: readonly RouteTraffic[];
  readonly stream?: { readonly route: string; readonly frames: number; readonly bytes: number };
}

export class SessionTraffic {
  readonly #routes = new Map<string, { answers: number; bytes: number }>();
  #stream: { route: string; frames: number; bytes: number } | undefined;

  answer(route: string, bytes: number, first: boolean): void {
    const key = this.#routes.has(route) || this.#routes.size < MAX_SESSION_ROUTE_TEMPLATES ? route : 'other';
    const count = this.#routes.get(key) ?? { answers: 0, bytes: 0 };
    if (first) count.answers += 1;
    count.bytes += bytes;
    this.#routes.set(key, count);
  }

  openStream(route: string): void {
    this.#stream = { route, frames: 0, bytes: 0 };
  }

  streamFrame(bytes: number): void {
    if (this.#stream === undefined) return;
    this.#stream.frames += 1;
    this.#stream.bytes += bytes;
  }

  snapshot(): SessionTrafficSnapshot {
    return {
      routes: [...this.#routes].map(([route, count]) => ({ route, ...count })),
      ...(this.#stream === undefined ? {} : { stream: { ...this.#stream } }),
    };
  }
}
