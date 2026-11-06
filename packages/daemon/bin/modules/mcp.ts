import { wrapperNameOf } from '@ferretry/fleet';
import { mcpOAuthSecretNames } from '@ferretry/protocol';
import { readDeclaredAccountModel, type ConfigAccountLocations } from '../../src/adapters/fleet/account-model-files.ts';
import { FileSecretDocumentStore, MCP_OAUTH_SECRETS_DOCUMENT } from '../../src/adapters/index.ts';
import {
  FileClaudeLocalScope,
  FileMcpHarnessDocuments,
  TransportMcpProbe,
} from '../../src/adapters/mcp-inventory/index.ts';
import {
  AccountModelMcpServers,
  FetchMcpOAuthHttp,
  FileMcpOAuthStateStore,
  webCryptoMcpOAuth,
} from '../../src/adapters/mcp-oauth/index.ts';
import { FileMcpProjectFiles } from '../../src/adapters/session-mcp/project-files.ts';
import type { ConfigFilesService } from '../../src/lib/config-files/index.ts';
import type { FleetLaunchEnvironment } from '../../src/lib/fleet/launch-environment.ts';
import type { PublishedFleetInventory } from '../../src/lib/fleet/publication.ts';
import {
  type ClockPort,
  combinedMcpOAuthServers,
  type FileSystemPort,
  type FoundationPaths,
  KnownAndFerretFolders,
  McpCheckService,
  type McpInventoryAccount,
  type McpInventoryFolder,
  McpInventoryService,
  McpOAuthService,
  type ManagedWorktreeService,
  mcpCheckBaseEnvironment,
  mcpInventoryFolders,
  ProjectMcpLaunch,
  ProjectMcpOAuthServers,
  type SecretCipherPort,
  SecretDirectory,
  SecretVault,
  type SessionDirectorySubsystem,
  type TextRedactor,
} from '../../src/lib/index.ts';
import type { McpOAuthClock, McpOAuthSecretWriter } from '../../src/lib/mcp-oauth/ports.ts';
import { type DaemonModule, type LateBound, lateBound } from '../../src/lib/runtime/modules.ts';
import type { CatalogSubsystem } from '../../src/lib/runtime/mounts/catalogs.ts';
import { mcpContribution } from '../../src/lib/runtime/mounts/mcp.ts';
import { createSessionMcpSubsystem, type SessionMcpSubsystem } from '../../src/lib/runtime/mounts/session-mcp.ts';
import { knownProjectRoots, type SessionMcpServiceDeps } from '../../src/lib/session-mcp/service.ts';

/**
 * Remote MCP servers: signing in to one from a browser (docs/mcp-oauth.md), every server a ferret sees and checking
 * one (docs/mcp-scopes.md), and adding one for a ferret (`/v1/sessions/:sessionId/mcp`).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries), no jobs and no releases: nothing here runs until a request, and the sign-in has no timer —
 * a token is refreshed only when a launch is about to use it.
 *
 * TWO CONSTRUCTION POINTS, as always: the sign-in half and the folder source are made by `buildWorld` BEFORE the
 * launch environment that reads them (`createMcpFoundations`, called on the line they were always made on), and the
 * inventory, the check and the session MCP subsystem are made by `createSubsystems`, on the line they were always
 * made on, once the session directory, the project catalogue, the worktrees and the fleet catalogue exist (`build`).
 * The folder source is a pair of {@link LateBound} values for the same reason it was a pair of reassigned members:
 * until `build` runs, no folder is known — the answer a read gave before is kept.
 */

/** What the sign-in half and the folder source are made from. */
export interface McpFoundationsNeeds {
  readonly paths: FoundationPaths;
  readonly stateFiles: FileSystemPort;
  /** Read for the machine's declared account model, whose components are the servers a person may sign in to. */
  readonly configFiles: Pick<ConfigFilesService, 'inEffect' | 'load'>;
  readonly configLocations: ConfigAccountLocations;
  /** The published runtimes, as the inventory names them. */
  readonly accounts: Pick<PublishedFleetInventory, 'accounts'>;
  /** The clock a sign-in's window is measured on. */
  readonly millisecondClock: McpOAuthClock;
  /** The daemon's ordinary secret store's write half: the ACCESS token, which a launch resolves. */
  readonly secretDirectory: McpOAuthSecretWriter;
  /** The ordinary store's open half: read only to revoke an access token at sign-out, and to launch a project server. */
  readonly secretVault: Pick<SecretVault, 'values'>;
  /** The key the daemon-internal document is sealed under, the SAME key as the ordinary store. */
  readonly secretCipher: SecretCipherPort;
  /** The clock the daemon-internal directory stamps with. */
  readonly clock: ClockPort;
}

/**
 * The sign-in half, the folder source and the project launch environment, made together because the launch
 * environment (`FleetLaunchEnvironment`) takes the sign-in service and the project launch at construction.
 */
export interface McpFoundations {
  /** Which project a folder is in — the ONE source the inventory, the sign-in and a launch all read. */
  readonly folders: KnownAndFerretFolders;
  /** The known folders, from the project catalogue and the worktree service; none until the module is built. */
  readonly knownFolders: LateBound<() => Promise<readonly McpInventoryFolder[]>>;
  /** The ferrets' folders, from the session directory; none until the module is built. */
  readonly ferretFolders: LateBound<() => Promise<readonly string[]>>;
  readonly documents: FileMcpHarnessDocuments;
  /** The published runtimes, as the MCP inventory names them: by runtime name, harness and config directory. */
  readonly accounts: () => Promise<readonly McpInventoryAccount[]>;
  readonly oauth: McpOAuthService;
  /**
   * A project's signed-in MCP servers reach a Claude ferret in that project as local-scope entries in its runtime's
   * own `.claude.json` (lib/mcp-inventory/project-sign-in.ts).
   */
  readonly launch: ProjectMcpLaunch;
}

export function createMcpFoundations(needs: McpFoundationsNeeds): McpFoundations {
  const { paths, stateFiles, secretCipher, clock } = needs;
  /**
   * Which project a folder is in, for MCP — the ONE source the inventory, the sign-in (a project's
   * `.mcp.json` servers sign in too, docs/mcp-scopes.md) and a launch all read. The known folders come
   * from the project catalogue and the worktree service, the ferrets' folders from the session
   * directory; all three mount with the subsystems below, and until they do there are none.
   */
  const knownFolders = lateBound<() => Promise<readonly McpInventoryFolder[]>>();
  const ferretFolders = lateBound<() => Promise<readonly string[]>>();
  const folders = new KnownAndFerretFolders(
    async () => (await knownFolders.current()?.()) ?? [],
    async () => (await ferretFolders.current()?.()) ?? [],
  );
  const documents = new FileMcpHarnessDocuments();
  /** The published runtimes, as the MCP inventory names them: by runtime name, harness and config directory. */
  const accounts = async (): Promise<readonly McpInventoryAccount[]> =>
    (await needs.accounts.accounts()).map(account => ({
      runtime: wrapperNameOf(account.wrapper),
      harness: account.kind,
      home: account.home,
      wrapper: account.wrapper,
    }));
  /**
   * Signing in to a remote MCP server from a browser (docs/mcp-oauth.md). The daemon is the OAuth client:
   * tokens go straight into the secret store through its WRITE half, and the vault is held only to spend
   * a refresh token at the provider that issued it. The launch environment asks it to refresh a token a
   * launch is about to use — that is the only refresh there is; no timer.
   */
  const oauth = new McpOAuthService({
    servers: combinedMcpOAuthServers(
      new AccountModelMcpServers(async () => await readDeclaredAccountModel(needs.configFiles, needs.configLocations)),
      new ProjectMcpOAuthServers(folders, documents),
    ),
    http: new FetchMcpOAuthHttp(),
    crypto: webCryptoMcpOAuth,
    clock: needs.millisecondClock,
    state: new FileMcpOAuthStateStore(paths, stateFiles),
    secrets: needs.secretDirectory,
    values: needs.secretVault,
    // Refresh tokens and client secrets: sealed under the same key in their own document, held by
    // nothing but this service — no route lists them, `use` cannot spend them, `${secret:…}` cannot
    // resolve them.
    internal: (() => {
      const internalDocuments = new FileSecretDocumentStore(paths, stateFiles, MCP_OAUTH_SECRETS_DOCUMENT);
      const directory = new SecretDirectory(internalDocuments, secretCipher, clock);
      const vault = new SecretVault(internalDocuments, secretCipher);
      return {
        list: async () => await directory.list(),
        put: async (name: string, value: string) => await directory.put(name, value),
        remove: async (name: string) => await directory.remove(name),
        values: async () => await vault.values(),
      };
    })(),
  });
  const launch = new ProjectMcpLaunch({
    accounts,
    folders,
    documents,
    secrets: needs.secretVault,
    renewal: oauth,
    localScope: new FileClaudeLocalScope(),
  });
  return { folders, knownFolders, ferretFolders, documents, accounts, oauth, launch };
}

/** What the mcp module is built from. */
export interface McpNeeds {
  /** The sign-in half and the folder source `buildWorld` made. */
  readonly foundations: McpFoundations;
  /** The session directory the inventory reads a ferret from, and which says where each ferret's folder is. */
  readonly sessions: Pick<SessionDirectorySubsystem, 'get' | 'list'>;
  /** The project catalogue: which folders are KNOWN roots a project write may use. */
  readonly catalogs: Pick<CatalogSubsystem, 'projects'>;
  /** The worktree service: a live managed worktree is a known root too. */
  readonly worktrees: Pick<ManagedWorktreeService, 'list'>;
  /** The fleet catalogue: the MCP components the inventory names, and the changes an add to a login proposes. */
  readonly fleetCatalog: SessionMcpServiceDeps['fleet'];
  /** What a runtime's harness is launched with, resolved: a check fills a component's `${VAR}` as the agent does. */
  readonly launchEnvironment: Pick<FleetLaunchEnvironment, 'forWrapper'>;
  /** The ordinary secret store's open half: the access token a check presents. */
  readonly secretVault: Pick<SecretVault, 'values'>;
  /** Scrubs a secret out of a check's own words. */
  readonly redactor: Pick<TextRedactor, 'redact'>;
  readonly clock: { now(): number };
  /** THIS PROCESS'S ENVIRONMENT, from which a check keeps only a small base (`PATH`, `HOME`, …) — never a token. */
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/** What other code may use from the mcp module. */
export interface McpProvides {
  /** The sign-in service, which the launch environment is also made from. */
  readonly oauth: McpOAuthService;
  /** Every MCP server a ferret sees; the shared-catalogue publisher lists them too. */
  readonly inventory: McpInventoryService;
  readonly check: McpCheckService;
  readonly sessionMcp: SessionMcpSubsystem;
}

export const mcpModule: DaemonModule<void, McpNeeds, McpProvides> = {
  id: 'mcp',
  build: needs => {
    const { foundations } = needs;
    foundations.knownFolders.bind(mcpInventoryFolders(needs.catalogs, needs.worktrees));
    foundations.ferretFolders.bind(async () => (await needs.sessions.list()).map(view => view.config.cwd));
    const inventory = new McpInventoryService({
      accounts: foundations.accounts,
      components: async () =>
        (await needs.fleetCatalog.components()).kinds
          .filter(group => group.kind === 'mcp')
          .flatMap(group => group.components)
          .map(component => ({
            name: component.name,
            runtimes: component.usedBy.runtimes,
            ...(component.detail.kind === 'mcp' && component.detail.auth === 'oauth' ? { auth: 'oauth' as const } : {}),
          })),
      folders: foundations.folders,
      connections: async () => await foundations.oauth.connections(),
      documents: foundations.documents,
      sessions: needs.sessions,
    });
    const check = new McpCheckService({
      inventory,
      probe: new TransportMcpProbe(),
      launchEnvironment: async runtime => {
        const account = (await foundations.accounts()).find(candidate => candidate.runtime === runtime);
        return account === undefined ? {} : await needs.launchEnvironment.forWrapper(account.wrapper);
      },
      baseEnvironment: () => mcpCheckBaseEnvironment(needs.environment),
      bearer: async (subject, url) => {
        const names = mcpOAuthSecretNames(subject, url);
        await foundations.oauth.refreshForLaunch([names.access]);
        return (await needs.secretVault.values()).get(names.access);
      },
      redactor: needs.redactor,
      now: () => needs.clock.now(),
    });
    // Built after the rest because it reads three of them: the session directory, and the project
    // catalogue and worktree service that say which folders are KNOWN roots a project write may use.
    // The fleet half goes through the very catalogue service Settings applies reviewed changes with.
    const sessionMcp = createSessionMcpSubsystem({
      sessions: needs.sessions,
      projectRoots: knownProjectRoots(needs.catalogs, needs.worktrees),
      files: new FileMcpProjectFiles(),
      fleet: needs.fleetCatalog,
    });
    return {
      id: 'mcp',
      provides: { oauth: foundations.oauth, inventory, check, sessionMcp },
      jobs: {},
      contributes: mcpContribution({ oauth: foundations.oauth, inventory: { inventory, check }, sessionMcp }),
    };
  },
};
