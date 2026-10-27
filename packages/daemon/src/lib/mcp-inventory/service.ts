/**
 * Every MCP server a ferret actually sees, from every scope, per harness (docs/mcp-scopes.md).
 *
 * WHAT IS READ is what the RUNTIME reads: its config directory under the fleet (the manifest's `home`),
 * never the person's own `~/.claude` or `~/.codex`, plus the project folders `./folders.ts` names. The
 * scope table is in `@ferretry/protocol` mcp-inventory; the rules for what a harness accepts are in
 * `./declarations.ts`.
 *
 * TWO VIEWS. The machine view lists every declaration once, with every runtime that sees it (and, for
 * a project server, whether each runtime may run it). The session view lists what ONE ferret sees: its
 * runtime's home and the project its folder is in, with the same-named servers a higher scope hides
 * marked rather than dropped.
 *
 * NOTHING SECRET LEAVES. The wire row (`toWire`) carries a server's program or address only; the
 * arguments, environment and headers stay in the {@link ResolvedMcpServer} a check uses.
 */
import { posix } from 'node:path';
import {
  MCP_SCOPE_PRECEDENCE,
  type McpApproval,
  type McpInventory,
  type McpInventoryProblem,
  type McpInventoryServer,
  type McpOAuthConnection,
  type McpRuntimeUse,
  type McpScope,
  type McpSignInTarget,
  type SessionView,
  sha256Hex,
} from '@ferretry/protocol';
import {
  type ClaudeApprovalKeys,
  claudeApproval,
  claudeApprovalKeys,
  claudeProjectEntry,
  claudeServers,
  codexServers,
  codexTrusted,
  type DeclarationsRead,
  displayTarget,
  isFerretryLocalEntry,
  type McpDeclaration,
} from './declarations.ts';
import { type McpInventoryFolder, type McpProjectFolders, mcpFolderSubject } from './folders.ts';

// ── Ports ────────────────────────────────────────────────────────────────────────────────────────

export type McpHarness = 'claude' | 'codex';

/** One published runtime: its name, its harness, and the config directory it runs with. */
export interface McpInventoryAccount {
  readonly runtime: string;
  readonly harness: McpHarness;
  readonly home: string;
  /** The published executable a session's `config.agent` names. */
  readonly wrapper: string;
}

/** A fleet MCP component and the runtimes whose profile stack carries it. */
export interface McpInventoryComponent {
  readonly name: string;
  readonly runtimes: readonly string[];
  readonly auth?: 'oauth';
}

/** A document a harness reads, already parsed. `null`: the file is not there. */
export interface McpHarnessDocuments {
  read(path: string, format: 'json' | 'toml'): Promise<unknown>;
}

/** A document that exists and cannot be read the way the harness reads it; the message names no value. */
export class McpDocumentUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpDocumentUnreadable';
  }
}

export interface McpInventoryDeps {
  accounts(): Promise<readonly McpInventoryAccount[]>;
  components(): Promise<readonly McpInventoryComponent[]>;
  /** Which project a folder is in: the same source the project sign-in list and a launch read. */
  readonly folders: McpProjectFolders;
  connections(): Promise<readonly McpOAuthConnection[]>;
  readonly documents: McpHarnessDocuments;
  readonly sessions: { get(sessionId: string): Promise<SessionView | undefined> };
}

export class McpInventoryRefusal extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpInventoryRefusal';
  }
}

// ── The model ────────────────────────────────────────────────────────────────────────────────────

/** Ferretry's own tools server: the fixed layer starts it in every runtime (`FERRETRY_MCP_SERVER`). */
export const FERRETRY_TOOLS_SERVER = 'ferretry';

/** One declaration, with everything a check needs. Never put on the wire as it is. */
export interface ResolvedMcpServer {
  readonly id: string;
  readonly scope: McpScope;
  readonly harness: McpHarness;
  readonly declaration: McpDeclaration | null;
  readonly source?: string;
  readonly project?: { readonly root: string; readonly name?: string };
  readonly runtimes: readonly McpRuntimeUse[];
  readonly shadowedBy?: McpScope;
  readonly signIn?: McpSignInTarget;
  /** The folder a command starts in: the project root for a project or local server. */
  readonly cwd?: string;
}

const CODEX_PROJECT_SIGN_IN =
  'Codex reads a project server’s token only from its own config, which Ferretry does not write per project yet. Add the server to the login instead, or run `codex mcp login` in the ferret.';

const serverId = (scope: McpScope, harness: McpHarness, source: string | undefined, name: string): string =>
  sha256Hex(`${scope}\n${harness}\n${source ?? ''}\n${name}`).slice(0, 24);

const harnessPaths = (harness: McpHarness, home: string) =>
  harness === 'claude'
    ? { config: posix.join(home, '.claude.json'), settings: posix.join(home, 'settings.json') }
    : { config: posix.join(home, 'config.toml'), settings: undefined };

/** Approval documents a project carries itself (`.claude/settings.json` and its local twin). */
const projectSettingsPaths = (root: string): readonly string[] => [
  posix.join(root, '.claude', 'settings.json'),
  posix.join(root, '.claude', 'settings.local.json'),
];

export const toWire = (server: ResolvedMcpServer, connections: readonly McpOAuthConnection[]): McpInventoryServer => {
  const connection =
    server.signIn === undefined ? undefined : connections.find(entry => entry.component === server.signIn?.subject);
  return {
    id: server.id,
    name: server.declaration?.name ?? FERRETRY_TOOLS_SERVER,
    scope: server.scope,
    harness: server.harness,
    transport: server.declaration?.transport ?? 'stdio',
    target: server.declaration === null ? 'fy mcp serve' : displayTarget(server.declaration),
    ...(server.source === undefined ? {} : { source: server.source }),
    ...(server.project === undefined ? {} : { project: server.project }),
    runtimes: server.runtimes,
    ...(server.shadowedBy === undefined ? {} : { shadowedBy: server.shadowedBy }),
    ...(server.signIn === undefined ? {} : { signIn: server.signIn }),
    ...(connection === undefined ? {} : { connection }),
  };
};

/** Precedence order index: lower wins. */
const rank = (scope: McpScope): number => MCP_SCOPE_PRECEDENCE.indexOf(scope);

/** A project server the harness never loads (not approved, or disabled) hides nothing. */
const loads = (server: ResolvedMcpServer): boolean =>
  server.scope !== 'project' || server.runtimes.some(use => use.approval === 'approved');

/** Marks, per harness and name, every declaration a higher-precedence one hides. */
function withShadows(servers: readonly ResolvedMcpServer[]): ResolvedMcpServer[] {
  return servers.map(server => {
    const name = server.declaration?.name ?? FERRETRY_TOOLS_SERVER;
    const winner = servers
      .filter(
        other =>
          other !== server &&
          loads(other) &&
          other.harness === server.harness &&
          (other.declaration?.name ?? FERRETRY_TOOLS_SERVER) === name &&
          rank(other.scope) < rank(server.scope) &&
          (other.project === undefined || server.project === undefined || other.project.root === server.project.root),
      )
      .sort((left, right) => rank(left.scope) - rank(right.scope))[0];
    return winner === undefined ? server : { ...server, shadowedBy: winner.scope };
  });
}

// ── The service ──────────────────────────────────────────────────────────────────────────────────

interface Reading {
  readonly problems: McpInventoryProblem[];
  read(path: string, format: 'json' | 'toml'): Promise<unknown>;
}

/** Reads each document once per request, and turns an unreadable one into a problem rather than a failure. */
function reading(documents: McpHarnessDocuments): Reading {
  const cache = new Map<string, Promise<unknown>>();
  const problems: McpInventoryProblem[] = [];
  return {
    problems,
    read(path, format) {
      const known = cache.get(path);
      if (known !== undefined) return known;
      const read = documents.read(path, format).catch((error: unknown) => {
        if (!(error instanceof McpDocumentUnreadable)) throw error;
        problems.push({ source: path, message: error.message });
        return null;
      });
      cache.set(path, read);
      return read;
    },
  };
}

const noteProblems = (into: McpInventoryProblem[], source: string, read: DeclarationsRead): void => {
  for (const message of read.problems) into.push({ source, message });
};

export class McpInventoryService {
  constructor(private readonly deps: McpInventoryDeps) {}

  /** `GET /v1/mcp`: every declaration on this machine, once, with every runtime that sees it. */
  async machine(): Promise<McpInventory> {
    const [servers, connections, problems] = await this.#machine();
    return { servers: servers.map(server => toWire(server, connections)), problems };
  }

  /** `GET /v1/sessions/:id/mcp/servers`: exactly what one ferret sees. */
  async session(sessionId: string): Promise<McpInventory> {
    const [servers, connections, problems] = await this.#session(sessionId);
    return { servers: servers.map(server => toWire(server, connections)), problems };
  }

  /** The declaration behind an id, from the session's view when one is named, else the machine's. */
  async resolve(id: string, sessionId?: string): Promise<ResolvedMcpServer> {
    const [servers] = sessionId === undefined ? await this.#machine() : await this.#session(sessionId);
    const server = servers.find(candidate => candidate.id === id);
    if (server === undefined)
      throw new McpInventoryRefusal(
        404,
        'mcp_server_unknown',
        'That server is no longer declared here. Read the list again.',
      );
    return server;
  }

  async #session(
    sessionId: string,
  ): Promise<readonly [ResolvedMcpServer[], readonly McpOAuthConnection[], McpInventoryProblem[]]> {
    const session = await this.deps.sessions.get(sessionId);
    if (session === undefined) throw new McpInventoryRefusal(404, 'not-found', `no session ${sessionId}`);
    const [accounts, components, folder, connections] = await Promise.all([
      this.deps.accounts(),
      this.deps.components(),
      this.deps.folders.forCwd(session.config.cwd),
      this.deps.connections(),
    ]);
    const account = accounts.find(
      candidate => candidate.wrapper === session.config.agent || candidate.runtime === session.config.agent,
    );
    const harness: McpHarness = account?.harness ?? (session.config.harness === 'codex' ? 'codex' : 'claude');
    const files = reading(this.deps.documents);
    const servers: ResolvedMcpServer[] = [this.#ferretry(harness, account === undefined ? [] : [account])];
    if (account !== undefined) servers.push(...(await this.#home(account, components, files)));
    servers.push(...(await this.#project(folder, harness, account === undefined ? [] : [account], files)));
    if (account !== undefined && harness === 'claude') servers.push(...(await this.#local(account, folder, files)));
    return [withShadows(servers), connections, files.problems];
  }

  async #machine(): Promise<readonly [ResolvedMcpServer[], readonly McpOAuthConnection[], McpInventoryProblem[]]> {
    const [accounts, components, folders, connections] = await Promise.all([
      this.deps.accounts(),
      this.deps.components(),
      this.deps.folders.list(),
      this.deps.connections(),
    ]);
    const files = reading(this.deps.documents);
    const servers: ResolvedMcpServer[] = [];
    for (const harness of ['claude', 'codex'] as const) {
      const runtimes = accounts.filter(account => account.harness === harness);
      if (runtimes.length === 0) continue;
      servers.push(this.#ferretry(harness, runtimes));
      for (const account of runtimes) servers.push(...(await this.#home(account, components, files)));
      for (const folder of folders) {
        servers.push(...(await this.#project(folder, harness, runtimes, files)));
        if (harness === 'claude')
          for (const account of runtimes) servers.push(...(await this.#local(account, folder, files)));
      }
    }
    // No shadows here: which declaration wins is a question about ONE home and ONE folder, the session view.
    return [merged(servers), connections, files.problems];
  }

  #ferretry(harness: McpHarness, accounts: readonly McpInventoryAccount[]): ResolvedMcpServer {
    return {
      id: serverId('ferretry', harness, undefined, FERRETRY_TOOLS_SERVER),
      scope: 'ferretry',
      harness,
      declaration: null,
      runtimes: accounts.map(account => ({ runtime: account.runtime })),
    };
  }

  /** The runtime's own config: its fleet components, and anything else written there (user scope). */
  async #home(
    account: McpInventoryAccount,
    components: readonly McpInventoryComponent[],
    files: Reading,
  ): Promise<ResolvedMcpServer[]> {
    const source = harnessPaths(account.harness, account.home).config;
    const read = (account.harness === 'claude' ? claudeServers : codexServers)(
      await files.read(source, account.harness === 'claude' ? 'json' : 'toml'),
    );
    noteProblems(files.problems, source, read);
    return read.servers
      .filter(declaration => declaration.name !== FERRETRY_TOOLS_SERVER)
      .map(declaration => {
        const component = components.find(
          candidate => candidate.name === declaration.name && candidate.runtimes.includes(account.runtime),
        );
        const scope: McpScope = component === undefined ? 'user' : 'component';
        const signIn: McpSignInTarget | undefined =
          component?.auth === 'oauth' && declaration.transport !== 'stdio'
            ? { subject: component.name, required: true }
            : undefined;
        // A component is one declaration however many homes it was written into.
        const at = scope === 'component' ? `component:${declaration.name}` : source;
        return {
          id: serverId(scope, account.harness, at, declaration.name),
          scope,
          harness: account.harness,
          declaration,
          ...(scope === 'user' ? { source } : {}),
          runtimes: [{ runtime: account.runtime }],
          ...(signIn === undefined ? {} : { signIn }),
        };
      });
  }

  /** The repo's own file: `.mcp.json` for Claude, `.codex/config.toml` for Codex, each with its approval. */
  async #project(
    folder: McpInventoryFolder,
    harness: McpHarness,
    accounts: readonly McpInventoryAccount[],
    files: Reading,
  ): Promise<ResolvedMcpServer[]> {
    const source =
      harness === 'claude' ? posix.join(folder.root, '.mcp.json') : posix.join(folder.root, '.codex', 'config.toml');
    const read = (harness === 'claude' ? claudeServers : codexServers)(
      await files.read(source, harness === 'claude' ? 'json' : 'toml'),
    );
    noteProblems(files.problems, source, read);
    if (read.servers.length === 0) return [];
    const projectSettings =
      harness === 'claude'
        ? await Promise.all(
            projectSettingsPaths(folder.root).map(async path => claudeApprovalKeys(await files.read(path, 'json'))),
          )
        : [];
    const servers: ResolvedMcpServer[] = [];
    for (const declaration of read.servers) {
      const runtimes: McpRuntimeUse[] = [];
      for (const account of accounts)
        runtimes.push({
          runtime: account.runtime,
          approval: await this.#approval(account, folder.root, declaration, projectSettings, files),
        });
      const signIn: McpSignInTarget | undefined =
        declaration.transport === 'stdio'
          ? undefined
          : {
              subject: mcpFolderSubject(folder, declaration.name),
              required: false,
              ...(harness === 'codex' ? { unsupported: CODEX_PROJECT_SIGN_IN } : {}),
            };
      servers.push({
        id: serverId('project', harness, source, declaration.name),
        scope: 'project',
        harness,
        declaration,
        source,
        project: { root: folder.root, ...(folder.name === undefined ? {} : { name: folder.name }) },
        runtimes,
        cwd: folder.root,
        ...(signIn === undefined ? {} : { signIn }),
      });
    }
    return servers;
  }

  async #approval(
    account: McpInventoryAccount,
    root: string,
    declaration: McpDeclaration,
    projectSettings: readonly ClaudeApprovalKeys[],
    files: Reading,
  ): Promise<McpApproval> {
    const paths = harnessPaths(account.harness, account.home);
    if (account.harness === 'codex') {
      if (declaration.disabled === true) return 'disabled';
      return codexTrusted(await files.read(paths.config, 'toml'), root) ? 'approved' : 'pending';
    }
    const home = await files.read(paths.config, 'json');
    const settings = paths.settings === undefined ? {} : await files.read(paths.settings, 'json');
    return claudeApproval(declaration.name, claudeProjectEntry(home, root), [
      claudeApprovalKeys(settings),
      ...projectSettings,
    ]);
  }

  /** Claude's local scope: `projects[<root>].mcpServers` in the runtime's own `.claude.json`. */
  async #local(account: McpInventoryAccount, folder: McpInventoryFolder, files: Reading): Promise<ResolvedMcpServer[]> {
    const source = harnessPaths('claude', account.home).config;
    const read = claudeServers(claudeProjectEntry(await files.read(source, 'json'), folder.root));
    noteProblems(files.problems, `${source} (projects › ${folder.root})`, read);
    // Ferretry's own entries are how a PROJECT server's sign-in reaches Claude: they are that server, not another.
    return read.servers
      .filter(declaration => !isFerretryLocalEntry(declaration))
      .map(declaration => ({
        id: serverId('local', 'claude', `${source}\n${folder.root}`, declaration.name),
        scope: 'local' as const,
        harness: 'claude' as const,
        declaration,
        source,
        project: { root: folder.root, ...(folder.name === undefined ? {} : { name: folder.name }) },
        runtimes: [{ runtime: account.runtime }],
        cwd: folder.root,
      }));
  }
}

/** One row per id: a component written into several homes is one declaration seen by several runtimes. */
function merged(servers: readonly ResolvedMcpServer[]): ResolvedMcpServer[] {
  const byId = new Map<string, ResolvedMcpServer>();
  for (const server of servers) {
    const known = byId.get(server.id);
    if (known === undefined) {
      byId.set(server.id, server);
      continue;
    }
    const runtimes = [...known.runtimes];
    for (const use of server.runtimes) if (!runtimes.some(entry => entry.runtime === use.runtime)) runtimes.push(use);
    byId.set(server.id, { ...known, runtimes });
  }
  return [...byId.values()];
}
