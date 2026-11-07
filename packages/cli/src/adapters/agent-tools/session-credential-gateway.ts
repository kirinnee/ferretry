import type { DaemonReply, DaemonTransport } from '../../lib/client.ts';
import { isLocalDaemonUrl } from '../../lib/address.ts';
import { SESSION_BEARER_PREFIX } from '../../lib/credential.ts';
import type { DaemonRequest } from '../../lib/request.ts';
import { assertOwnLoopbackListener, type ListenerGuardPorts } from '../daemon/listener-guard.ts';
import { type Fetcher, HttpTransport, type RestartWaiting } from '../daemon/http-transport.ts';

export interface SessionGatewayOptions {
  readonly baseUrl: () => Promise<string>;
  /** The ferret's own `fys_` credential. */
  readonly bearer: string;
  /** `FY_SESSION_ID`: the pane this process runs in, sent so a person-only route can refuse a ferret that names itself. */
  readonly ferretId?: string;
  readonly fetcher?: Fetcher;
  /** A ferret always waits out a restart: it only exists because a daemon ran it. */
  readonly restart?: RestartWaiting;
  readonly listeners?: ListenerGuardPorts;
  readonly timeoutMs?: number;
}

/**
 * The daemon, as a FERRET reaches it: `Authorization: Bearer fys_…` and nothing else (S52, S53).
 *
 * It never reads the host's admin token and drops any other `authorization` a caller passes, because a tools server
 * that held host authority would be an agent holding it. A refusal is final (S54): there is no second credential to
 * fall back to. It talks only to a daemon on this machine, whose port this user owns (S57): a session credential sent
 * anywhere else would be a credential leaving the machine. A restart is waited out.
 */
export class SessionCredentialGateway implements DaemonTransport {
  readonly #inner: HttpTransport;

  constructor(options: SessionGatewayOptions) {
    if (!options.bearer.startsWith(SESSION_BEARER_PREFIX))
      throw new Error(`a ferret credential starts with ${SESSION_BEARER_PREFIX}`);
    this.#inner = new HttpTransport({
      baseUrl: options.baseUrl,
      authorization: async () => `Bearer ${options.bearer}`,
      beforeSend: async base => {
        if (!isLocalDaemonUrl(base))
          throw new Error(`a ferret’s fy talks only to the daemon on this machine, and ${base} is not on it`);
        await assertOwnLoopbackListener(base, 'the session credential', options.listeners);
      },
      headers: {
        'x-ferretry-client': 'cli',
        ...(options.ferretId === undefined ? {} : { 'x-ferretry-session-id': options.ferretId }),
      },
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      ...(options.restart === undefined ? {} : { restart: options.restart }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  send(request: DaemonRequest, options: { readonly repeatable: boolean }): Promise<DaemonReply> {
    return this.#inner.send(request, options);
  }
}
