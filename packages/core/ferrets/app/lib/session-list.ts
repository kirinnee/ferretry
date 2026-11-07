/**
 * THE FERRET LIST, READ CONDITIONALLY (R502). Every open app re-reads the fleet on a beat, and an unchanged one
 * answers `304` instead of its whole list again (about 25 KB on a real fleet, on a metered relay).
 *
 * One list is held per reader, which is per daemon connection. The list is parsed once and frozen all the way down,
 * and every read answers that one frozen value: a `304` costs no parse and no copy, and a caller cannot change the
 * held list through what it was given (a write throws). The held entry is captured BEFORE the request, so a read
 * that overlapped this one and already holds a newer list keeps it.
 *
 * Copied from today's `FyApiClient.list()` (`packages/protocol/src/adapters/fy-api-client.ts`). The half that read a
 * daemon with no `etag` in full, as before, is gone (A452): every daemon tags the list (R501), so an answer without
 * one is refused rather than read untagged.
 */

/** What one `GET /v1/ferrets` exchange answered; `body` is absent on a `304`. */
export interface SessionListAnswer {
  readonly status: number;
  readonly etag: string | null;
  readonly body?: unknown;
}

/** Sends the list read, with `If-None-Match` when a list is held. The shell's client is behind it. */
export type SessionListExchange = (headers: Readonly<Record<string, string>>) => Promise<SessionListAnswer>;

/** The list read answered without the tag every daemon sends (R501). */
export class UntaggedSessionListError extends Error {
  constructor() {
    super('the machine answered its ferret list without an etag');
    this.name = 'UntaggedSessionListError';
  }
}

interface Held<T> {
  readonly etag: string;
  readonly sessions: readonly T[];
}

function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** One connection's conditional ferret-list reader. */
export class ConditionalSessionList<T> {
  #held: Held<T> | undefined;

  constructor(
    private readonly exchange: SessionListExchange,
    private readonly parse: (body: unknown) => readonly T[],
  ) {}

  async read(): Promise<readonly T[]> {
    const held = this.#held;
    const answer = await this.exchange(held === undefined ? {} : { 'if-none-match': held.etag });
    // Whatever is held now stays: a read that overlapped this one may already hold a newer list.
    if (held !== undefined && answer.status === 304) return held.sessions;
    if (answer.etag === null) throw new UntaggedSessionListError();
    const sessions = freezeDeep(this.parse(answer.body));
    this.#held = { etag: answer.etag, sessions };
    return sessions;
  }
}
