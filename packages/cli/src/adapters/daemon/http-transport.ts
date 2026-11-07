import type { DaemonReply, DaemonTransport, SendOptions } from '../../lib/client.ts';
import type { DaemonRequest } from '../../lib/request.ts';
import {
  type Attempt,
  classifyUnreachable,
  daemonStartingOf,
  type RestartPatience,
  waitOutRestart,
} from '../../lib/restart.ts';

/** How long one request may take: longer than the longest thing the daemon holds open inside one. */
const DEFAULT_TIMEOUT_MS = 60_000;

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface RestartWaiting {
  readonly patience: RestartPatience;
  readonly nowMs: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface HttpTransportOptions {
  readonly baseUrl: () => Promise<string>;
  /** The `Authorization` header value for this request, or `undefined` to send none. */
  readonly authorization: () => Promise<string | undefined>;
  /** Asked before EVERY attempt, a resend included, with the address that attempt goes to (the loopback and
   * own-listener checks). A throw is final: the request is not sent and the restart wait ends. */
  readonly beforeSend?: (baseUrl: string) => Promise<void>;
  /** Fixed headers (client name, the ferret's own id). An `authorization` here is dropped: only `authorization()` sets it. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetcher?: Fetcher;
  readonly restart?: RestartWaiting;
  readonly timeoutMs?: number;
}

/** JSON over HTTP to the daemon's local listener. Never throws for an HTTP status: the client above decides. */
export class HttpTransport implements DaemonTransport {
  constructor(private readonly options: HttpTransportOptions) {}

  async send(request: DaemonRequest, { repeatable, recheck }: SendOptions): Promise<DaemonReply> {
    const fetcher = this.options.fetcher ?? ((url, init) => fetch(url, init));
    let headers: Headers | undefined;
    // The credential is read once per request, and only after an address has passed the check: a refused check
    // never reads it.
    const headersFor = async (): Promise<Headers> => {
      if (headers !== undefined) return headers;
      const built = new Headers(this.options.headers);
      built.delete('authorization');
      const authorization = await this.options.authorization();
      if (authorization !== undefined) built.set('authorization', authorization);
      if (request.body !== undefined) built.set('content-type', 'application/json');
      headers = built;
      return built;
    };
    // EVERY attempt reads the address again and asks the guard about THAT address before anything is sent (S57). A
    // daemon that was away has left its port free, so a resend may find another user's listener there, or the daemon
    // back on another port: the check of the first attempt says nothing about either. A refusal is final, never waited.
    const attempt = async (): Promise<Attempt<Response>> => {
      let base: string;
      let sending: Headers;
      try {
        base = await this.options.baseUrl();
        await this.options.beforeSend?.(base);
        sending = await headersFor();
      } catch (error) {
        return { kind: 'failed', error };
      }
      try {
        const response = await fetcher(`${base}${request.path}`, {
          method: request.method,
          headers: sending,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        // A daemon that has bound its address but not mounted its routes ran nothing: still away.
        const starting = await daemonStartingOf(response);
        if (starting !== undefined) throw starting;
        return { kind: 'answered', value: response };
      } catch (error) {
        const how = classifyUnreachable(error);
        return how === undefined ? { kind: 'failed', error } : { kind: 'unreachable', how, error };
      }
    };
    // A resend follows a daemon that was away: it may have come back on another build, so the caller's guard is asked
    // again BEFORE the request goes out a second time. Its refusal ends the wait; a daemon still away keeps it going.
    // The resend itself then goes through `attempt`, so its address is read and checked afresh.
    const again = async (): Promise<Attempt<Response>> => {
      if (recheck !== undefined) {
        try {
          await recheck();
        } catch (error) {
          const how = classifyUnreachable(error);
          return how === undefined ? { kind: 'failed', error } : { kind: 'unreachable', how, error };
        }
      }
      return await attempt();
    };
    const first = await attempt();
    const outcome =
      this.options.restart === undefined
        ? first
        : await waitOutRestart({ ...this.options.restart, attempt: again, first, repeatable });
    if (outcome.kind !== 'answered') throw outcome.error;
    const text = await outcome.value.text();
    return { status: outcome.value.status, body: parseBody(text) };
  }
}

function parseBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
