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
 * 3. the variable is added to the launch environment, resolved;
 * 4. the entry also names a `headersHelper` (`fy mcp token <VARIABLE>`), which Claude runs at connect time and again
 *    after a 401 to get the CURRENT header. Without it a ferret that outlives its access token (Slack's lives
 *    12 hours) keeps sending the one it was launched with and every call fails; `/mcp` cannot help, because it
 *    expands the same stale variable. The static header stays as the fallback for a Claude that does not run the
 *    helper.
 *
 * The configuration file holds a variable NAME, never the token — the same boundary, and the same GAP
 * (the agent can read its own environment), as a component's sign-in. The helper extends that boundary in time and
 * no further: `POST /v1/sessions/:sessionId/mcp/token` (`./ferret-token.ts`) hands a ferret ONLY the token its own
 * launch already put in its environment, renewed, and only to that ferret.
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
  /**
   * Claude's `headersHelper` for this server: a command that prints its CURRENT headers, run at connect time and
   * again after a 401 — so a ferret that outlives its access token is kept signed in. Optional so an entry an
   * earlier daemon wrote (header only) still reads as ours.
   */
  readonly headersHelper?: string;
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
  readonly renewal?: {
    refreshForLaunch(names: readonly SecretName[]): Promise<void>;
    /** The sign-in that filed this access secret, when its refresh was rejected so only the person can mend it. */
    signInRequired?(name: SecretName): Promise<string | undefined>;
  };
  readonly localScope: ClaudeLocalScope;
  /** The `headersHelper` command for one sign-in variable (`claudeMcpTokenCommand`, bound to this machine's `fy`). */
  readonly tokenCommand: (variable: string) => string;
}

/**
 * What a running ferret is told when it asks for the token behind one of its own launch variables.
 *
 * `unknown`: this ferret's launch holds no such variable. `needs-sign-in`: it does, but the sign-in cannot supply a
 * working token — the person must sign in again in Ferretry — and `server` names which. Never carries provider text.
 */
export type FerretMcpToken =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'needs-sign-in'; readonly server: string }
  | { readonly kind: 'unknown' };

/** One signed-in project server as a launch would use it, resolved and checked against the approvals. */
interface ProjectServerLaunch {
  readonly declaration: RemoteDeclaration;
  readonly variable: string;
  readonly accessName: SecretName;
  /** Absent when the person has not signed in to it. */
  readonly token: string | undefined;
  /** Whether the runtime has said no to it in this project. */
  readonly disabled: boolean;
}

interface ProjectLaunch {
  readonly claudeJson: string;
  readonly root: string;
  /** The runtime's `.claude.json`, as read. */
  readonly home: unknown;
  readonly servers: readonly ProjectServerLaunch[];
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
    const launch = await this.#resolve(agent, cwd);
    if (launch === undefined) return {};
    const servers: Record<string, LocalScopeServer> = {};
    const env: Record<string, string> = {};
    for (const { declaration, variable, token, disabled } of launch.servers) {
      if (token === undefined || disabled) continue;
      servers[declaration.name] = {
        type: declaration.transport,
        url: declaration.url,
        headers: { ...declaration.headers, Authorization: `Bearer \${${variable}}` },
        headersHelper: this.deps.tokenCommand(variable),
      };
      env[variable] = token;
    }
    // Reconciled even when empty: a sign-out, or a server removed from `.mcp.json`, leaves no entry behind.
    if (Object.keys(servers).length > 0 || hasFerretryEntry(claudeProjectEntry(launch.home, launch.root)))
      await this.deps.localScope.reconcile(launch.claudeJson, launch.root, servers);
    return env;
  }

  /**
   * The token one of this folder's project servers is launched with, renewed — or why there is none. A server the
   * runtime disabled, or one this project does not have, is `unknown`: the launch would not have put it there.
   */
  async token(agent: string, cwd: string, variable: string): Promise<FerretMcpToken> {
    const server = (await this.#resolve(agent, cwd, variable))?.servers[0];
    if (server === undefined || server.disabled) return { kind: 'unknown' };
    if (server.token === undefined || (await this.deps.renewal?.signInRequired?.(server.accessName)) !== undefined)
      return { kind: 'needs-sign-in', server: server.declaration.name };
    return { kind: 'token', token: server.token };
  }

  /**
   * The part of a launch both ways of asking share: renewal, the stored values and the approvals.
   *
   * `only` narrows it to ONE server's variable, for a running ferret's token request: that server alone is
   * renewed, and only if the runtime has not disabled it — an unknown or disabled variable renews nothing and
   * resolves to no server at all. Without it, every remote server of the project is renewed, as a launch needs.
   */
  async #resolve(agent: string, cwd: string, only?: string): Promise<ProjectLaunch | undefined> {
    const account = (await this.deps.accounts()).find(
      candidate => candidate.wrapper === agent || candidate.runtime === agent,
    );
    if (account === undefined || account.harness !== 'claude') return undefined;
    const folder = await this.deps.folders.forCwd(cwd);
    const root = folder.root.replace(/\/+$/u, '');
    const claudeJson = `${account.home.replace(/\/+$/u, '')}/.claude.json`;
    const remote = await remoteServers(this.deps.documents, root);
    const home = await this.#read(claudeJson);
    const settings = claudeApprovalKeys(await this.#read(`${account.home.replace(/\/+$/u, '')}/settings.json`));
    const named = remote
      .map(declaration => ({
        declaration,
        names: mcpOAuthSecretNames(mcpFolderSubject(folder, declaration.name), declaration.url),
        disabled: claudeApproval(declaration.name, claudeProjectEntry(home, root), [settings]) === 'disabled',
      }))
      .filter(entry => only === undefined || (entry.names.variable === only && !entry.disabled));
    if (named.length > 0) await this.deps.renewal?.refreshForLaunch(named.map(entry => entry.names.access));
    const values = named.length === 0 ? new Map<SecretName, string>() : await this.deps.secrets.values();
    return {
      claudeJson,
      root,
      home,
      servers: named.map(({ declaration, names, disabled }) => ({
        declaration,
        variable: names.variable,
        accessName: names.access,
        token: values.get(names.access),
        disabled,
      })),
    };
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
