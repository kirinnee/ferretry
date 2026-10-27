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
 * 3. the variable is added to the launch environment, resolved.
 *
 * The configuration file holds a variable NAME, never the token — the same boundary, and the same GAP
 * (the agent can read its own environment), as a component's sign-in.
 *
 * WHAT IT RESPECTS. A runtime that DISABLED the server in this project gets no override: somebody said
 * no there. A runtime that has not been asked yet gets it — signing in was an explicit act behind
 * `fleet`/`configure`, and the override runs nothing (it is a web address).
 */
import type { SecretName } from '@ferretry/protocol';
import { mcpOAuthSecretNames, parseMcpProjectSubject } from '@ferretry/protocol';
import type { McpOAuthServer, McpOAuthServers } from '../mcp-oauth/ports.ts';
import {
  claudeApproval,
  claudeApprovalKeys,
  claudeProjectEntry,
  claudeServers,
  isFerretryLocalEntry,
  type McpDeclaration,
} from './declarations.ts';
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

/**
 * The runtime's `.claude.json`, for Ferretry's own local-scope entries in one project. `reconcile`
 * leaves every entry somebody else wrote alone, and replaces exactly the set Ferretry owns — recognised
 * by an `Authorization` header that names a Ferretry sign-in variable — with `servers`.
 */
export interface ClaudeLocalScope {
  reconcile(claudeJson: string, root: string, servers: Readonly<Record<string, LocalScopeServer>>): Promise<void>;
}

export interface ProjectMcpLaunchDeps {
  accounts(): Promise<readonly McpInventoryAccount[]>;
  /** Which project a folder is in: the same source the inventory and the sign-in list read. */
  readonly folders: McpProjectFolders;
  readonly documents: McpHarnessDocuments;
  readonly secrets: { values(): Promise<ReadonlyMap<SecretName, string>> };
  readonly renewal?: { refreshForLaunch(names: readonly SecretName[]): Promise<void> };
  readonly localScope: ClaudeLocalScope;
}

export class ProjectMcpLaunch {
  constructor(private readonly deps: ProjectMcpLaunchDeps) {}

  /**
   * The variables one launch needs for the project servers its folder's project has signed in to, after
   * writing their local-scope entries. `{}` for a Codex runtime, or a project with no signed-in server —
   * and then any entry an earlier launch wrote is removed. A folder in no registered project or managed
   * worktree is a project of its own, exactly as its ferret is listed.
   */
  async forLaunch(agent: string, cwd: string): Promise<Readonly<Record<string, string>>> {
    const account = (await this.deps.accounts()).find(
      candidate => candidate.wrapper === agent || candidate.runtime === agent,
    );
    if (account === undefined || account.harness !== 'claude') return {};
    const folder = await this.deps.folders.forCwd(cwd);
    const root = folder.root.replace(/\/+$/u, '');
    const claudeJson = `${account.home.replace(/\/+$/u, '')}/.claude.json`;
    const remote = await remoteServers(this.deps.documents, root);
    const named = remote.map(declaration => ({
      declaration,
      names: mcpOAuthSecretNames(mcpFolderSubject(folder, declaration.name), declaration.url),
    }));
    if (named.length > 0) await this.deps.renewal?.refreshForLaunch(named.map(entry => entry.names.access));
    const values = named.length === 0 ? new Map<SecretName, string>() : await this.deps.secrets.values();
    const home = await this.#read(claudeJson);
    const settings = claudeApprovalKeys(await this.#read(`${account.home.replace(/\/+$/u, '')}/settings.json`));
    const servers: Record<string, LocalScopeServer> = {};
    const env: Record<string, string> = {};
    for (const { declaration, names } of named) {
      const token = values.get(names.access);
      if (token === undefined) continue;
      if (claudeApproval(declaration.name, claudeProjectEntry(home, root), [settings]) === 'disabled') continue;
      servers[declaration.name] = {
        type: declaration.transport,
        url: declaration.url,
        headers: { ...declaration.headers, Authorization: `Bearer \${${names.variable}}` },
      };
      env[names.variable] = token;
    }
    // Reconciled even when empty: a sign-out, or a server removed from `.mcp.json`, leaves no entry behind.
    if (Object.keys(servers).length > 0 || hasFerretryEntry(claudeProjectEntry(home, root)))
      await this.deps.localScope.reconcile(claudeJson, root, servers);
    return env;
  }

  async #read(path: string): Promise<unknown> {
    try {
      return await this.deps.documents.read(path, 'json');
    } catch (error) {
      if (error instanceof McpDocumentUnreadable) return null;
      throw error;
    }
  }
}

const hasFerretryEntry = (projectEntry: unknown): boolean => {
  if (typeof projectEntry !== 'object' || projectEntry === null) return false;
  const servers = (projectEntry as { readonly mcpServers?: unknown }).mcpServers;
  return typeof servers === 'object' && servers !== null && Object.values(servers).some(isFerretryLocalEntry);
};
