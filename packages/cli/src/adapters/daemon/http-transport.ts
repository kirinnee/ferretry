import type { PluginSocket, PluginSocketListeners } from '@ferretry/kernel/manifest';
import type { DaemonReply, DaemonTransport, RawEvent, SendOptions } from '../../lib/client.ts';
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

/** What the event feed and a stream need of a socket; a `WebSocket` is one. */
export interface FeedSocket {
  onopen?: (() => void) | null;
  send?(frame: string | Uint8Array): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly reason?: string; readonly code?: number }) => void) | null;
  onerror: (() => void) | null;
  close(code?: number, reason?: string): void;
}

/** Opens the feed's (and a stream's) socket. Production passes `new WebSocket`; tests pass a fake, so no test opens a connection. */
export type FeedSocketOpener = (url: string, headers: Readonly<Record<string, string>>) => FeedSocket;

/** Bun's `WebSocket` takes request headers as a second argument, which the DOM type does not know. */
const bunSocket: FeedSocketOpener = (url, headers) =>
  new (WebSocket as unknown as new (target: string, options: { headers: Record<string, string> }) => FeedSocket)(url, {
    headers: { ...headers },
  });

/**
 * The daemon's event BUS feed: a socket that sends one `{ name, payload }` JSON frame per event. `/v1/events` is the
 * session journal stream (Ferrets declares it, the kernel serves it) and is not this socket.
 * The kernel declares and serves it (one frame per event the caller's admission lets it discover).
 */
const BUS_PATH = '/v1/bus';
const MAX_EVENT_NAME = 128;

export interface RestartWaiting {
  readonly patience: RestartPatience;
  readonly nowMs: () => number;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
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
  /** Opens the event feed's and every stream's socket; the default is a `WebSocket`. */
  readonly feedSocket?: FeedSocketOpener;
  readonly timeoutMs?: number;
}

/** JSON over HTTP to the daemon's local listener. Never throws for an HTTP status: the client above decides. */
export class HttpTransport implements DaemonTransport {
  constructor(private readonly options: HttpTransportOptions) {}

  async send(request: DaemonRequest, { repeatable, recheck, signal }: SendOptions): Promise<DaemonReply> {
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
          signal:
            signal === undefined
              ? AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
              : AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS), signal]),
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
        : await waitOutRestart({ ...this.options.restart, attempt: again, first, repeatable, signal });
    if (outcome.kind !== 'answered') throw outcome.error;
    const text = await outcome.value.text();
    return { status: outcome.value.status, body: parseBody(text) };
  }

  /**
   * Opens the event feed. It goes through the SAME address and credential rules as a request: the address is read now
   * and judged by `beforeSend` BEFORE the credential is read, and a refusal ends the feed unopened. A feed does not
   * reconnect; its end is reported, and whoever follows it decides.
   */
  events(listener: (event: RawEvent) => void, onClose: (reason: string) => void): () => void {
    let cancelled = false;
    let ended = false;
    let socket: FeedSocket | undefined;
    const end = (reason: string): void => {
      if (cancelled || ended) return;
      ended = true;
      onClose(reason);
    };
    void (async () => {
      try {
        const { url, headers } = await this.#target(BUS_PATH);
        if (cancelled) return;
        const open = this.options.feedSocket ?? bunSocket;
        const opened = open(url, headers);
        socket = opened;
        opened.onmessage = message => {
          if (typeof message.data !== 'string') return;
          let value: unknown;
          try {
            value = JSON.parse(message.data);
          } catch {
            return;
          }
          if (typeof value !== 'object' || value === null) return;
          const { name, payload } = value as { name?: unknown; payload?: unknown };
          if (typeof name === 'string' && name.length <= MAX_EVENT_NAME) listener({ name, payload });
        };
        opened.onclose = closed =>
          end(closed.reason === undefined || closed.reason === '' ? 'the daemon closed the event feed' : closed.reason);
        opened.onerror = () => end('the event feed failed');
      } catch (error) {
        end(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
      socket?.close(1000, 'cancelled');
    };
  }

  /**
   * Opens one daemon stream (`path` is the route's path with its query, already encoded) through the SAME address and
   * credential rules as `send` and `events`: the address is read now and judged by `beforeSend` BEFORE the credential is
   * read, the credential travels as the `authorization` header and never in the URL, and a refusal ends the stream
   * unopened. The caller's `close` is the cancel (default: close `1000` 'event stream cancelled'), after which the
   * listener hears nothing more. A close the caller did not ask for is reported as an error sentence with its code; a
   * frame sent before the daemon accepted the stream is dropped.
   */
  socket(path: string, listeners: PluginSocketListeners): PluginSocket {
    let closing = false;
    let ended = false;
    let accepted = false;
    let socket: FeedSocket | undefined;
    const end = (reason: string, code?: number): void => {
      if (closing || ended) return;
      ended = true;
      if (code === undefined) listeners.onClose(reason);
      else listeners.onClose(reason, code);
    };
    void (async () => {
      try {
        const { url, headers } = await this.#target(path);
        if (closing) return;
        const opened = (this.options.feedSocket ?? bunSocket)(url, headers);
        socket = opened;
        opened.onopen = () => {
          if (closing || ended) return;
          accepted = true;
          listeners.onOpen?.();
        };
        opened.onmessage = message => {
          if (closing || ended) return;
          const frame = frameOf(message.data);
          if (frame !== undefined) listeners.onFrame(frame);
        };
        opened.onclose = closed => {
          const detail =
            closed.reason === undefined || closed.reason === ''
              ? `code ${String(closed.code)}`
              : `${closed.reason} (code ${String(closed.code)})`;
          end(`WebSocket stream closed unexpectedly: ${detail}`, closed.code);
        };
        opened.onerror = () => end('WebSocket stream failed');
      } catch (error) {
        end(error instanceof Error ? error.message : String(error));
      }
    })();
    return {
      send: frame => {
        if (accepted && !closing && !ended) socket?.send?.(frame);
      },
      close: (code = 1000, reason = 'event stream cancelled') => {
        if (closing) return;
        closing = true;
        socket?.close(code, reason);
      },
    };
  }

  /**
   * Where a socket to `path` goes and what it carries: the address read now and judged, THEN the credential. The path
   * must stay on the address that passed the check, so a path that names another host is refused before the credential
   * is read.
   */
  async #target(path: string): Promise<{ readonly url: string; readonly headers: Record<string, string> }> {
    const base = await this.options.baseUrl();
    await this.options.beforeSend?.(base);
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin) throw new Error('a stream path must stay on the daemon address');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const headers: Record<string, string> = { ...this.options.headers };
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'authorization') delete headers[name];
    const authorization = await this.options.authorization();
    if (authorization !== undefined) headers.authorization = authorization;
    return { url: url.toString(), headers };
  }
}

/** A text frame, or the bytes of a binary one; anything else (a Blob this runtime did not decode) is not a frame. */
function frameOf(data: unknown): string | Uint8Array | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return undefined;
}

function parseBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
