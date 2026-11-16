/**
 * Which hosts the MCP sign-in may reach: the `mcp-sign-in` network resolver's whole answer.
 *
 * The kernel asks the resolver, with nothing about the request, at every outbound fetch. It answers three sets and
 * no other host:
 *
 * 1. the hosts of the servers with a web address NOW (every configured item with a `url`, and project servers with a
 *    web address): the ones a person may sign in to and the ones a check reaches. Refreshed every time the sign-in
 *    service lists its servers, and before a check reaches a web address. It is NOT refreshed on a
 *    configuration change (the plan said it would be): a removed server stays answered until the next list, which
 *    every start makes before it fetches anything, so nothing reaches it that a list would not;
 * 2. the issuer and token and revocation endpoint hosts of the sign-ins already recorded in `state/mcp/oauth.json`
 *    (so a renewal and a sign-out reach the provider that issued the token), refreshed every time that document is
 *    read or written;
 * 3. the hosts a sign-in in flight discovered: the authorization server a server's protected-resource metadata
 *    named, and the registration, token and revocation endpoints its metadata named. Each is recorded only AFTER it
 *    passed `endpointAllowed`, so a public server that names a loopback or private address adds nothing. That includes
 *    the host a 401 challenge's `resource_metadata` names (RFC 9728 lets it live anywhere, as in v4). The hosts are
 *    kept PER FLOW and each set expires at its own flow's expiry, so a second start never shortens or lengthens
 *    the first flow's reach, and a start that fails, a flow that completes, is cancelled, replaced or expires gives
 *    up only its own.
 *
 * Limits of what this can say, because the kernel's matching rule is `{ resolver }` over host names:
 * - An answer with no port (a default-port address) matches the host on ANY port and on plain `http:`. The service
 *   fetches only addresses that passed `endpointAllowed`, so this is defence in depth only.
 * - The answer is one union of every live flow, request-agnostic. A loopback or private server's flow may record
 *   private HTTPS hosts (`endpointAllowed` allows that for a local server) and those are answered to every other flow
 *   while it lives. The service's own `endpointAllowed` still guards each flow.
 * - Set 1 includes the hosts of project `.mcp.json` servers, which an agent working in a worktree can write; that
 *   address is not checked by `endpointAllowed`. See the `mcp` line of `ports-pending.json`.
 *
 * Nothing here holds a token, a code or a verifier: only host names.
 */
import type { McpOAuthServers, McpOAuthStateDocument, McpOAuthStateStore } from './oauth/ports.ts';
import { MAX_PENDING_FLOWS } from './oauth/service.ts';

/**
 * At most this many sign-ins discovering at once, and this many hosts each: a hostile server cannot grow the set.
 * Twice the service's pending-flow limit, so the service's `admit` stays the one place that evicts a live flow: the
 * extra entries are only starts still in flight, and this bound never strips another pending flow's hosts.
 */
const MAX_DISCOVERING = 2 * MAX_PENDING_FLOWS;
const MAX_HOSTS_PER_FLOW = 8;

/** The service's side of the reach: it names what discovery found, and ends a flow's hosts. */
export interface McpDiscoveryRecorder {
  /**
   * `url` has passed the endpoint rule: its host is reachable for the flow `flowId` until `expiresAt` (the flow's own
   * expiry, in clock milliseconds) or until the flow ends, whichever is first.
   */
  discovered(flowId: string, url: string, expiresAt: number): void;
  /** The flow `flowId` ended (finished, replaced, cancelled, expired, or its start failed). Only its own hosts go. */
  release(flowId: string): void;
}

const hostOf = (url: string): string | undefined => (URL.canParse(url) ? new URL(url).host.toLowerCase() : undefined);

export class SignInReach implements McpDiscoveryRecorder {
  private servers: ReadonlySet<string> = new Set();
  private recorded: ReadonlySet<string> = new Set();
  /** The hosts each live flow discovered, per FLOW, each with that flow's own expiry. */
  private readonly discovering = new Map<string, { readonly hosts: Set<string>; readonly expiresAt: number }>();

  constructor(private readonly clock: { now(): number }) {}

  /** What the resolver answers: every host of the three sets that is still live. */
  hosts(): readonly string[] {
    const now = this.clock.now();
    const live = [...this.discovering.values()]
      .filter(entry => entry.expiresAt > now)
      .flatMap(entry => [...entry.hosts]);
    return [...new Set([...this.servers, ...this.recorded, ...live])];
  }

  discovered(flowId: string, url: string, expiresAt: number): void {
    const host = hostOf(url);
    if (host === undefined) return;
    const now = this.clock.now();
    for (const [name, entry] of this.discovering) if (entry.expiresAt <= now) this.discovering.delete(name);
    const held = this.discovering.get(flowId);
    if (held === undefined) {
      while (this.discovering.size >= MAX_DISCOVERING)
        this.discovering.delete(this.discovering.keys().next().value as string);
      this.discovering.set(flowId, { hosts: new Set([host]), expiresAt });
    } else if (held.hosts.size < MAX_HOSTS_PER_FLOW) held.hosts.add(host);
  }

  release(flowId: string): void {
    this.discovering.delete(flowId);
  }

  /** The servers' list, noting every server with a web address: one to sign in to, and one a check may reach. */
  observeServers(source: McpOAuthServers): McpOAuthServers {
    return {
      list: async () => {
        const listed = await source.list();
        this.servers = new Set(
          listed.flatMap(server => {
            const host = server.url !== undefined ? hostOf(server.url) : undefined;
            return host === undefined ? [] : [host];
          }),
        );
        return listed;
      },
      missing: async component => await source.missing?.(component),
    };
  }

  /** The sign-in's state document, noting the providers its recorded sign-ins went through. */
  observeState(store: McpOAuthStateStore): McpOAuthStateStore {
    const note = (document: McpOAuthStateDocument): void => {
      this.recorded = new Set(
        Object.values(document.connections).flatMap(record =>
          [record.issuer, record.tokenEndpoint, record.revocationEndpoint].flatMap(url => {
            const host = url === undefined ? undefined : hostOf(url);
            return host === undefined ? [] : [host];
          }),
        ),
      );
    };
    return {
      read: async () => {
        const document = await store.read();
        note(document);
        return document;
      },
      write: async document => {
        await store.write(document);
        note(document);
      },
    };
  }
}
