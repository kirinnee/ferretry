import {
  BROWSER_STATE_PATH,
  BrowserStateViewSchema,
  type IFyApiClient,
  type LoopbackFirewallState,
} from '@ferretry/protocol';

/**
 * The loopback-firewall line `fy daemon status` adds: the daemon's own reading, or nothing.
 *
 * It rides the AUTHENTICATED `GET /v1/browser/state`, never the unauthenticated health route: on a shared host
 * "this account's browser is unprotected right now" is something only its owner should be able to ask. Nothing,
 * rather than a failure, for every reason the read can fail — no token yet, an older daemon whose state has no
 * such field, a daemon that stopped since the health probe — because `status` reports on the daemon and its exit
 * code is the daemon's, never this line's.
 */
export class ProtocolFirewallStatusReader {
  constructor(
    private readonly client: Pick<IFyApiClient, 'request'>,
    private readonly timeoutMs = 3_000,
  ) {}

  async read(): Promise<LoopbackFirewallState | undefined> {
    try {
      return (await this.client.request(BROWSER_STATE_PATH, BrowserStateViewSchema, undefined, this.timeoutMs))
        .firewall;
    } catch {
      return undefined;
    }
  }
}
