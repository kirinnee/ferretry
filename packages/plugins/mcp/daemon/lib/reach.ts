/**
 * Which hosts the MCP sign-in may reach: the `mcp-sign-in` network resolver's whole answer.
 *
 * The kernel asks the resolver, with nothing about the request, at every outbound fetch. It answers three sets and
 * no other host:
 *
 * 1. the hosts of the servers a person may sign in to NOW (configured items with `auth: oauth`, and project servers
 *    with a web address), refreshed every time the sign-in service lists its servers;
 * 2. the issuer and token and revocation endpoint hosts of the sign-ins already recorded in `state/mcp/oauth.json`
 *    (so a renewal and a sign-out reach the provider that issued the token), refreshed every time that document is
 *    read or written;
 * 3. the hosts a sign-in in flight discovered: the authorization server a server's protected-resource metadata
 *    named, and the registration, token and revocation endpoints its metadata named. Each is recorded only AFTER it
 *    passed `endpointAllowed`, so a public server that names a loopback or private address adds nothing, and each
 *    expires with the flow (the flow's time to live), is dropped when the flow completes, is cancelled or expires.
 *
 * Nothing here holds a token, a code or a verifier: only host names.
 */
import type { McpOAuthServers, McpOAuthStateDocument, McpOAuthStateStore } from './oauth/ports.ts';

/** At most this many sign-ins discovering at once, and this many hosts each: a hostile server cannot grow the set. */
const MAX_DISCOVERING = 16;
const MAX_HOSTS_PER_FLOW = 8;

/** The service's side of the reach: it names what discovery found, and ends a flow's hosts. */
export interface McpDiscoveryRecorder {
  /** `url` has passed the endpoint rule: its host is reachable for `component`'s flow until the flow ends. */
  discovered(component: string, url: string): void;
  /** The flow of `component` ended (finished, cancelled, expired, or discovery failed). */
  release(component: string): void;
}

const hostOf = (url: string): string | undefined => (URL.canParse(url) ? new URL(url).host.toLowerCase() : undefined);

export class SignInReach implements McpDiscoveryRecorder {
  private servers: ReadonlySet<string> = new Set();
  private recorded: ReadonlySet<string> = new Set();
  private readonly discovering = new Map<string, { readonly hosts: Set<string>; readonly expiresAt: number }>();

  constructor(
    private readonly clock: { now(): number },
    private readonly ttlMs: number,
  ) {}

  /** What the resolver answers: every host of the three sets that is still live. */
  hosts(): readonly string[] {
    const now = this.clock.now();
    const live = [...this.discovering.values()]
      .filter(entry => entry.expiresAt > now)
      .flatMap(entry => [...entry.hosts]);
    return [...new Set([...this.servers, ...this.recorded, ...live])];
  }

  discovered(component: string, url: string): void {
    const host = hostOf(url);
    if (host === undefined) return;
    const now = this.clock.now();
    for (const [name, entry] of this.discovering) if (entry.expiresAt <= now) this.discovering.delete(name);
    const held = this.discovering.get(component);
    if (held === undefined) {
      while (this.discovering.size >= MAX_DISCOVERING)
        this.discovering.delete(this.discovering.keys().next().value as string);
      this.discovering.set(component, { hosts: new Set([host]), expiresAt: now + this.ttlMs });
    } else if (held.hosts.size < MAX_HOSTS_PER_FLOW) held.hosts.add(host);
  }

  release(component: string): void {
    this.discovering.delete(component);
  }

  /** The sign-in's server list, noting every server that may sign in. */
  observeServers(source: McpOAuthServers): McpOAuthServers {
    return {
      list: async () => {
        const listed = await source.list();
        this.servers = new Set(
          listed.flatMap(server => {
            const host = server.url !== undefined && server.auth === 'oauth' ? hostOf(server.url) : undefined;
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
