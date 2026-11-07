/**
 * Signing in to a PROJECT's MCP server from Ferretry, and handing the token to Claude Code for that
 * project only (docs/mcp-scopes.md › Signing in to a project server).
 *
 * WHY THIS EXISTS. A `.mcp.json` server that asks for OAuth was left to Claude Code to sign in to
 * itself. Claude's own sign-in sends the browser back to a localhost port on the ferret's machine — a
 * phone, or a laptop reaching a remote box, can never finish it — so a project server was listed,
 * could not be checked, and could not be signed in to.
 *
 * WHAT IT DOES. The sign-in is the components' flow unchanged (docs/mcp-oauth.md), filed under the
 * server's SUBJECT (`mcpProjectSubject`: its name and a digest of its project's root) and the address the
 * project file names, so every worktree of one project shares it and another project's same-named server
 * does not. At launch, for a Claude ferret whose folder is in that project:
 *
 * 1. the access token is renewed if it is about to expire, exactly as a component's is;
 * 2. the server is written to the runtime's LOCAL scope for that project — `projects[<root>].mcpServers`
 *    in its own `.claude.json` — with an `Authorization` header naming a launch variable. Claude uses a
 *    local server in place of a same-named project one (local › project › user), and expands `${VAR}`
 *    in its headers from its own environment;
 * 3. the variable is added to the launch environment as an optional `${secret?:NAME}` REFERENCE, which the
 *    Vault opens into the child's environment as it starts (use, never read): MCP never holds the value, and a
 *    sign-out landing before the Vault opens it leaves the variable unset instead of refusing the launch.
 *
 * The configuration file holds a variable NAME, never the token — the same boundary, and the same GAP
 * (the agent can read its own environment), as a component's sign-in.
 *
 * ON 5.0 the Claude Code harness writes its own local scope, so the launch is asked for its
 * {@link ProjectMcpLaunchShare} — the entries as data, handed on as `mcp` launch parts. MCP holds no root
 * over the harness's home: it neither reads nor writes `.claude.json`.
 *
 * WHAT IT RESPECTS. A runtime that DISABLED the server in this project gets no override: somebody said
 * no there. A runtime that has not been asked yet gets it — signing in was an explicit act behind
 * `fleet`/`configure`, and the override runs nothing (it is a web address). Whether the runtime said no
 * is the HARNESS's answer (`approvedProjectServers` on its contract), read by the harness plugin from its
 * own home. A harness that takes no project server (Codex, as today) is handed nothing.
 *
 * FAIL CLOSED. A harness that is off, does not answer, or could not read its own documents gives no
 * decision, so no project server gets a variable or a local entry: the token is never handed to a runtime
 * that may have declined it. Its sign-ins are still renewed.
 */
import { optionalSecretReference, type SecretName } from '@ferretry/core-vault/contract';
import { mcpOAuthSecretNames, parseMcpProjectSubject } from '../../../contract/index.ts';
import type { McpOAuthServer, McpOAuthServers } from '../oauth/ports.ts';
import { claudeServers, type McpDeclaration } from './declarations.ts';
import { type McpProjectFolders, mcpFolderSubject, mcpProjectKey } from './folders.ts';
import { McpDocumentUnreadable, type McpHarnessDocuments, type McpInventoryAccount } from './service.ts';

/**
 * The project's own `.mcp.json` remote servers, as sign-in targets — from the very folders the inventory
 * lists them from (`./folders.ts`), so every subject a row offers is one this list holds.
 */
export class ProjectMcpOAuthServers implements McpOAuthServers {
  constructor(
    private readonly folders: McpProjectFolders,
    private readonly documents: McpHarnessDocuments,
  ) {}

  async list(): Promise<readonly McpOAuthServer[]> {
    const servers = new Map<string, McpOAuthServer>();
    for (const folder of await this.folders.list())
      for (const declaration of await remoteServers(this.documents, folder.root)) {
        const component = mcpFolderSubject(folder, declaration.name);
        // The registered project's own file wins over a worktree's copy of it.
        if (!servers.has(component) || folder.root === folder.project)
          servers.set(component, {
            component,
            url: declaration.url,
            auth: 'oauth',
            optional: true,
            ...(declaration.oauth === undefined ? {} : { client: declaration.oauth }),
          });
      }
    return [...servers.values()];
  }

  /** Why a project subject is not listed, naming the project it was looked for in when there is one. */
  async missing(subject: string): Promise<string | undefined> {
    const parsed = parseMcpProjectSubject(subject);
    if (parsed === null) return undefined;
    const folders = await this.folders.list();
    const project = folders.find(folder => mcpProjectKey(folder.project) === parsed.projectKey)?.project;
    if (project !== undefined)
      return `There is no web MCP server named “${parsed.name}” in ${project.replace(/\/+$/u, '')}/.mcp.json any more. Read the list again.`;
    return `“${parsed.name}” belongs to a project (${parsed.projectKey}) Ferretry does not know on this machine any more: none of the ${folders.length} project, worktree and ferret folders it knows is that project. Read the list again from the ferret it belongs to.`;
  }
}

/** Both kinds of sign-in target, components first: a component name can never be a project subject. */
export const combinedMcpOAuthServers = (...sources: readonly McpOAuthServers[]): McpOAuthServers => ({
  list: async () => (await Promise.all(sources.map(source => source.list()))).flat(),
  missing: async component => {
    for (const source of sources) {
      const reason = await source.missing?.(component);
      if (reason !== undefined) return reason;
    }
    return undefined;
  },
});

type RemoteDeclaration = Extract<McpDeclaration, { readonly url: string }>;

async function remoteServers(documents: McpHarnessDocuments, root: string): Promise<readonly RemoteDeclaration[]> {
  try {
    return claudeServers(await documents.read(`${root.replace(/\/+$/u, '')}/.mcp.json`, 'json')).servers.filter(
      (declaration): declaration is RemoteDeclaration => declaration.transport !== 'stdio',
    );
  } catch (error) {
    if (error instanceof McpDocumentUnreadable) return [];
    throw error;
  }
}

/** One local-scope server Ferretry writes for a signed-in project server. */
export interface LocalScopeServer {
  readonly type: 'http' | 'sse';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** What the launch's harness decided about one project server (its contract's `ProjectServerApproval`). */
export type McpProjectApproval = 'approved' | 'pending' | 'disabled';

/**
 * The harness's own answer to "which of these servers did you approve for this ferret in `root`" — the
 * `approvedProjectServers` read on the Claude Code and Codex contracts, the same three states. MCP never reads the
 * harness's home itself (lead ruling: no harness-home root for MCP).
 */
export type McpProjectApprovals =
  | { readonly state: 'read'; readonly servers: Readonly<Record<string, McpProjectApproval>> }
  | { readonly state: 'unreadable'; readonly reason: string }
  | { readonly state: 'not-taken'; readonly reason: string };

export interface McpProjectApprovalsRequest {
  readonly account: McpInventoryAccount;
  /** The folder the servers are declared in, as the harness keys its per-project decisions. */
  readonly root: string;
  readonly servers: readonly string[];
}

export interface ProjectMcpLaunchDeps {
  accounts(): Promise<readonly McpInventoryAccount[]>;
  /** Which project a folder is in: the same source the inventory and the sign-in list read. */
  readonly folders: McpProjectFolders;
  /** The launch folder's own `.mcp.json`; the harness's home is never read through this. */
  readonly documents: McpHarnessDocuments;
  /**
   * The harness's answer, or `undefined` when the harness is off or does not answer (a plugin that is off provides nothing).
   * Undefined and `unreadable` both bind nothing: fail closed.
   */
  approvals(request: McpProjectApprovalsRequest): Promise<McpProjectApprovals | undefined>;
  /** Which secret NAMES the Vault holds — never a value (use, never read). */
  readonly secrets: { held(): Promise<ReadonlySet<SecretName>> };
  readonly renewal?: { refreshForLaunch(names: readonly SecretName[]): Promise<void> };
}

/** What one launch gets for its project's signed-in servers. */
export interface ProjectMcpLaunchShare {
  /** The project root the local-scope entries are for. */
  readonly root: string;
  /** The local-scope entries, by server name: each names its variable, never the token. */
  readonly servers: Readonly<Record<string, LocalScopeServer>>;
  /**
   * Each variable bound to its OPTIONAL `${secret?:NAME}` reference: the Vault opens it for the child, and leaves the
   * variable unset if a sign-out removed the token before the launch opened it (today read the value once).
   */
  readonly env: Readonly<Record<string, string>>;
}

const NOTHING_TO_ADD: ProjectMcpLaunchShare = { root: '', servers: {}, env: {} };

export class ProjectMcpLaunch {
  constructor(private readonly deps: ProjectMcpLaunchDeps) {}

  /**
   * The variables one launch needs for the project servers its folder's project has signed in to. `{}` for a harness
   * that takes no project server (Codex: `not-taken`, as today), an unknown runtime, or a project with no signed-in
   * server. A folder in no registered project is a project of its own, exactly as its ferret is listed.
   */
  async forLaunch(agent: string, cwd: string): Promise<Readonly<Record<string, string>>> {
    return (await this.share(agent, cwd)).env;
  }

  /** {@link forLaunch}'s whole answer: the local-scope entries (handed on as `mcp` launch parts) as well. */
  async share(agent: string, cwd: string): Promise<ProjectMcpLaunchShare> {
    const account = (await this.deps.accounts()).find(
      candidate => candidate.wrapper === agent || candidate.runtime === agent,
    );
    if (account === undefined) return NOTHING_TO_ADD;
    const folder = await this.deps.folders.forCwd(cwd);
    const root = folder.root.replace(/\/+$/u, '');
    const remote = await remoteServers(this.deps.documents, root);
    const named = remote.map(declaration => ({
      declaration,
      names: mcpOAuthSecretNames(mcpFolderSubject(folder, declaration.name), declaration.url),
    }));
    const approvals = await this.deps.approvals({
      account,
      root,
      servers: named.map(entry => entry.declaration.name),
    });
    // A harness that takes no project server is handed nothing and renews nothing for it (today's Codex).
    if (approvals?.state === 'not-taken') return NOTHING_TO_ADD;
    // Renewal on USE: the only moment a token is refreshed is the moment a launch needs it.
    if (named.length > 0) await this.deps.renewal?.refreshForLaunch(named.map(entry => entry.names.access));
    const held = named.length === 0 ? new Set<SecretName>() : await this.deps.secrets.held();
    // FAIL CLOSED: the harness's answer decides every binding; no answer (off, unreadable) binds nothing.
    const decided = approvals?.state === 'read' ? approvals.servers : undefined;
    // Built from entries, never by assignment: a server may be named `__proto__`, and `servers['__proto__'] = …`
    // would set the object's prototype instead of adding the entry.
    const servers: [string, LocalScopeServer][] = [];
    const env: [string, string][] = [];
    for (const { declaration, names } of named) {
      if (decided === undefined || !held.has(names.access)) continue;
      // The harness's OWN answer for this name only: a plain lookup of `constructor` or `__proto__` reads
      // `Object.prototype`, which is neither undefined nor 'disabled'.
      const approval = Object.hasOwn(decided, declaration.name) ? decided[declaration.name] : undefined;
      // An allow-list: a runtime that DISABLED it said no there, and a server the harness did not answer for (or
      // answered anything else for) is not assumed approved.
      if (approval !== 'approved' && approval !== 'pending') continue;
      servers.push([
        declaration.name,
        {
          type: declaration.transport,
          url: declaration.url,
          headers: { ...declaration.headers, Authorization: `Bearer \${${names.variable}}` },
        },
      ]);
      env.push([names.variable, optionalSecretReference(names.access)]);
    }
    return { root, servers: Object.fromEntries(servers), env: Object.fromEntries(env) };
  }
}
