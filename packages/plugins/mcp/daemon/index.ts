import type { ConfigCollectionDef, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import type { CatalogMcpProvider, McpComponentRecord } from '@ferretry/plugin-catalogs/contract';
import type { SecretName, SecretSummary } from '@ferretry/core-vault/contract';
import type { RuntimeId } from '@ferretry/plugin-runtimes/contract';
import {
  MCP_CONFIG,
  mcpOAuthSecretNames,
  McpServerAdded,
  McpSignInChanged,
  type McpApi,
  type McpItem,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { CatalogMcpProjectFile } from './adapters/catalog-project-file.ts';
import { ConfigMcpServers } from './adapters/config-servers.ts';
import { harnessProjectApprovals } from './adapters/harness-approvals.ts';
import { RootMcpHarnessDocuments } from './adapters/harness-documents.ts';
import { FetchMcpOAuthHttp } from './adapters/oauth-http.ts';
import { webCryptoMcpOAuth } from './adapters/oauth-crypto.ts';
import { sealedMcpOAuthSecrets } from './adapters/oauth-sealed-secrets.ts';
import { StateMcpOAuthStateStore } from './adapters/oauth-state-store.ts';
import { TransportMcpProbe } from './adapters/probe.ts';
import { type FerretRoot, RootMcpProjectFiles } from './adapters/project-files.ts';
import { PROJECT_MCP_FILE, projectRootMcpFile } from './adapters/project-root-files.ts';
import { McpCheckService, mcpCheckBaseEnvironment } from './lib/inventory/check.ts';
import {
  KnownAndFerretFolders,
  type McpInventoryFolder,
  managedWorktreeRows,
  mcpInventoryFolders,
} from './lib/inventory/folders.ts';
import { McpDocumentUnreadable, type McpInventoryAccount, McpInventoryService } from './lib/inventory/service.ts';
import { CheckSpawnReach, ReachedProbe } from './lib/check-reach.ts';
import { SignInReach } from './lib/reach.ts';
import { combinedMcpOAuthServers, ProjectMcpLaunch, ProjectMcpOAuthServers } from './lib/inventory/project-sign-in.ts';
import { PublishedHomeDocuments, type PublishedHomes } from './lib/inventory/home-documents.ts';
import { parseHarnessDocument } from './lib/inventory/parse-document.ts';
import { accountsOf, componentsOf, layeredMcp } from './lib/inventory/runtime-wiring.ts';
import { mcpCatalogRuntime } from './lib/catalog-runtime.ts';
import { McpLaunchParts } from './lib/launch-parts.ts';
import { mcpComponentSource } from './lib/profile-component-source.ts';
import { McpOAuthService } from './lib/oauth/service.ts';
import { runtimesLoginTarget } from './lib/session/login-target.ts';
import { SessionMcpService } from './lib/session/service.ts';
import { inventoryRoutes, oauthRoutes, sessionRoutes } from './routes.ts';

/** Why the seams MCP may not fill itself refuse. Each says what is missing, in words. */
const NOT_YET = (what: string): never => {
  throw new Error(`${what} is not available on this machine yet.`);
};

/**
 * MCP (§2.3): MCP servers as items, their sign-ins, and the per-ferret wiring.
 *
 * SEAMS NOT BOUND HERE (declared GAPS; each refuses in words rather than guess):
 * - Runtimes (an optional `uses`) answers the accounts (one per runtime a published home lists), which MCP items each
 *   runtime's profile stack carries, and the bounded read of a home's `.claude.json`, `settings.json` and
 *   `config.toml` (`lib/inventory/home-documents.ts`: exactly those three names, nothing else of a home). A launch
 *   carries only the items its runtime's profile names. Runtimes off: no accounts and no item on any launch, and a
 *   login add answers `mcp_runtime_unknown`. A login add reads the ferret's runtime and profile from it, writes the
 *   item to this plugin's own `config/mcp/<name>.yaml`, and Runtimes adds the one `mcp/<name>` layer under the
 *   caller's own standing; Catalogs belongs to a later unit. A project add lands only at a known root (below),
 *   through the ferret's own `work` root, so a ferret in a SUBFOLDER of a registered project is told in words that the
 *   root's file is outside its folder (declared GAP: it needs the kernel's `project-files` root, the M5 unit).
 * - Projects (an optional `uses`) gives the registered roots and Ferrets' `managedWorktrees()` the managed worktrees
 *   (`<home>-worktrees`), so a subfolder of a registered project, a worktree kept inside it, and a managed worktree
 *   of it are that project, under its root's subject digest, as today. Projects off: a managed worktree belongs to
 *   the repository it was forked from, and every other folder is its own project. The `.mcp.json` at each of those
 *   known roots — that one file, read-only — is read through the kernel's `imports` root scoped to the root and
 *   anchored at it (`adapters/project-root-files.ts`), so a ferret in a subfolder reads it with no ferret in the
 *   project root. A `.mcp.json` that is a link is refused; a root that is (or sits under) a link is read as the
 *   folder it names.
 * - The Vault has no value getter (use, never read). Sign-in writes the ACCESS token by name through `VaultApi.put`;
 *   the refresh token and a registered client secret (the "internal" store) rest in MCP's own sealed document,
 *   `state/mcp/oauth-secrets.json` (today's `mcp-oauth-secrets.json`), opened through the Vault's sealed-document
 *   port and handed to the sign-in service alone. Reading a held ACCESS token back (revoke it at sign-out, a check's
 *   bearer) needs a Vault operation that spends a named secret for this plugin; until that contract change it is not
 *   sent (sign-out revokes with the held refresh token, and answers `revoked: false` when there is none).
 * - Whether a runtime DISABLED a project server is the HARNESS's answer (`approvedProjectServers`, the optional
 *   `uses` of Claude Code), read by the harness plugin from its own home: MCP has no root there. A harness that is
 *   off or does not answer binds nothing (fail closed, `ProjectMcpLaunch`); its sign-ins are still renewed. Claude
 *   Code's daemon half serves the read from the ferret home its harness writes (`agent-homes`, scoped to that
 *   ferret), and its launches merge `.claude.json` rather than replace it, so a server the person disabled stays
 *   disabled. A Codex launch is handed no project server and renews none (`not-taken`, as today), answered by MCP
 *   whatever Codex's daemon half says.
 * - A CHECK (`fy mcp check`): the command is started with the kernel's own small base (`PATH`, `HOME`) and every `${secret:NAME}`
 *   in its environment resolved for that one child through the Vault (use, never read; a secret not held refuses by
 *   NAME). A runtime profile's secret bindings are published by Runtimes as references (`RuntimeHome.secretEnv`, the
 *   manifest account's `secretEnv`, v4 `forWrapper`) and sealed for the checked child with the server's own through
 *   `VaultApi.childEnvironmentForRuntime` (the `profileSecrets` grant): they fill no `${VAR}`. A HELD sign-in token is
 *   presented to a remote server by the Vault (`VaultApi.fetchMinted`), never read here, and everything the server says
 *   back is scrubbed before it is shown. The kernel starts a check's command only if `permissions.spawn` allows it: the
 *   `mcp-check` resolver (`lib/check-reach.ts`), only the one command of the one check, for the length of its probe.
 * - GAP (declared): the narrowing of the `imports` grant to `<known root>/.mcp.json` is enforced by MCP's adapter
 *   (`adapters/project-root-files.ts`), not by the kernel, which would hand MCP's `imports` root any folder outside
 *   the fence. Closing it needs a kernel root scoped to one file.
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const { ferrets, vault, sealed } = ctx.needs;
    const { claudeCode, projects, runtimes } = ctx.uses;
    const published = (): PublishedHomes | undefined => runtimes.current();

    // ── what a ferret's folder is: these folders are inventory read roots, never project registrations ────────────
    const owners = new Map<string, FerretId>();
    const refreshOwners = async (): Promise<readonly string[]> => {
      const all = await ferrets.list();
      owners.clear();
      for (const ferret of all) owners.set(ferret.folder, ferret.id);
      return all.map(ferret => ferret.folder);
    };
    const inside = (folder: string, path: string): boolean =>
      path === folder || path.startsWith(`${folder.replace(/\/+$/u, '')}/`);
    const workRootFor = (path: string): FerretRoot => {
      const owner = [...owners].filter(([folder]) => inside(folder, path)).sort(([a], [b]) => b.length - a.length)[0];
      if (owner === undefined)
        throw new McpDocumentUnreadable(`${path} is outside every ferret folder, so Ferretry will not read it.`);
      return { root: kernel.roots.root('work', { ferret: owner[1] }), base: owner[0] };
    };

    const items = (): ReadonlyMap<string, McpItem> =>
      kernel.config.collection(MCP_CONFIG as ConfigCollectionDef<McpItem>);

    // ── sign-in ────────────────────────────────────────────────────────────────────────────────────────────────────
    const secrets = {
      list: async (): Promise<readonly SecretSummary[]> => await vault.names(),
      put: async (name: SecretName, value: string): Promise<SecretSummary> => {
        await vault.put(name, value);
        const held = (await vault.names()).find(summary => summary.name === name);
        return held ?? NOT_YET('The secret just stored');
      },
      remove: async (name: SecretName): Promise<boolean> => await vault.remove(name),
    };
    // ── what a ferret's folder holds: one source for the inventory and the launch ──────────────────────────────────
    // The known roots, as today's `mcpInventoryFolders`: registered projects (Projects), then live managed worktrees
    // (Ferrets' registry), each joined to the project registered for its common directory, else its repository.
    const known = async (): Promise<readonly McpInventoryFolder[]> => {
      const registered = (await projects.current()?.list()) ?? [];
      const managed = (await ferrets.managedWorktrees?.()) ?? [];
      return await mcpInventoryFolders(
        { projects: async () => registered },
        { list: async () => ({ worktrees: managedWorktreeRows(managed, registered) }) },
      )();
    };
    const folders = new KnownAndFerretFolders(known, refreshOwners);
    // A known root's `.mcp.json` — and nothing else there — is read through the kernel's `imports` root scoped to that
    // folder (lead ruling (B)), so a ferret in a subfolder reads it with no ferret in the project root. Every other
    // document is read through the ferret folder that holds it, as before.
    const projectFile = projectRootMcpFile((root, within) => kernel.roots.root('imports', { subfolder: root, within }));
    // A runtime home Runtimes published is read through its bounded reader, by exact document name; the rest as before.
    const rootDocuments = new RootMcpHarnessDocuments(async path => {
      if (path.endsWith(`/${PROJECT_MCP_FILE}`)) {
        const held = projectFile(
          path,
          (await known()).map(folder => folder.root),
        );
        if (held !== undefined) return held;
      }
      return workRootFor(path);
    }, parseHarnessDocument);
    const documents = new PublishedHomeDocuments(published, parseHarnessDocument, rootDocuments);
    const held = async (): Promise<ReadonlySet<SecretName>> =>
      new Set((await vault.names()).map(summary => summary.name));

    // ── sign-in: the servers (components and projects') and the hosts it may reach ─────────────────────────────────
    // The `mcp-sign-in` network resolver answers only the hosts of the servers listed now, those of the sign-ins on
    // file, and the ones a flow's metadata named (`lib/reach.ts`).
    const reach = new SignInReach({ now: () => kernel.clock.nowMs() });
    const checkSpawn = new CheckSpawnReach();
    const servers = reach.observeServers(
      combinedMcpOAuthServers(new ConfigMcpServers(items), new ProjectMcpOAuthServers(folders, documents)),
    );
    const oauth = new McpOAuthService({
      servers,
      http: new FetchMcpOAuthHttp(kernel.fetch),
      crypto: webCryptoMcpOAuth,
      clock: { now: () => kernel.clock.nowMs() },
      state: reach.observeState(new StateMcpOAuthStateStore(kernel.state)),
      secrets,
      values: { values: async () => new Map() },
      // Refresh tokens and client secrets: MCP's own sealed document, held by nothing but this service (S8, S174).
      internal: sealedMcpOAuthSecrets(sealed, kernel.state),
      reach,
    });

    // ── every launch: renew the sign-ins it uses, then name them (today's launch environment, `modules/mcp.ts`) ──
    const accounts = async (): Promise<readonly McpInventoryAccount[]> =>
      accountsOf((await runtimes.current()?.homes()) ?? []);
    const launch = new McpLaunchParts({
      items,
      held,
      renewal: oauth,
      layered: async runtime => await layeredMcp(runtimes.current(), runtime),
      project: async spec => {
        // The ferret folders are the read roots, so they are read fresh before the launch's own folder is.
        await refreshOwners();
        // The launch is its runtime's account when Runtimes published one (its home, as a v4 launch read it); else its
        // own, from the runtime, harness and home the spec carries. Whether the runtime declined a server is its
        // harness's answer, never a read of its home here (GAP above).
        const agent = spec.runtime ?? spec.ferret;
        const own = (await accounts()).find(account => account.runtime === spec.runtime);
        return await new ProjectMcpLaunch({
          accounts: async () => [own ?? { runtime: agent, wrapper: agent, harness: spec.harness, home: spec.home }],
          folders,
          documents,
          approvals: harnessProjectApprovals({ 'claude-code': () => claudeCode.current() }, spec.harness, spec.ferret),
          secrets: { held },
          renewal: oauth,
        }).share(agent, spec.folder);
      },
    });

    // ── inventory and check ────────────────────────────────────────────────────────────────────────────────────────
    const inventory = new McpInventoryService({
      accounts,
      components: async () => await componentsOf(items(), runtimes.current()),
      folders,
      connections: async () => await oauth.connections(),
      documents,
      ferrets: {
        get: async id => {
          const ferret = await ferrets.get(id as FerretId);
          return ferret === undefined
            ? undefined
            : {
                id: ferret.id,
                harness: ferret.harness,
                folder: ferret.folder,
                ...(ferret.runtime === undefined ? {} : { runtime: ferret.runtime }),
              };
        },
      },
    });
    /**
     * A held sign-in for a check, renewed first when it is about to expire (as a launch renews it): the NAME of the
     * access-token secret this plugin minted and the variable a harness reads it from. The value is never read here: the
     * Vault places it on the request (`VaultApi.fetchMinted`), and only when this plugin wrote it. `undefined` when none
     * is held: the server then answers `needs-sign-in`.
     */
    const heldSignIn = async (
      subject: string,
      url: string,
    ): Promise<{ readonly secret: string; readonly variable: string } | undefined> => {
      const names = mcpOAuthSecretNames(subject, url);
      await oauth.refreshForLaunch([names.access]);
      return (await vault.has(names.access)) ? { secret: names.access, variable: names.variable } : undefined;
    };
    const check = new McpCheckService({
      inventory,
      // A command's `${secret:NAME}` values are opened by the Vault into that one child's environment. The Vault reads no
      // ferret for a plugin's own handle, and a check is the machine's, not a ferret's, so none is named. A handle the
      // check already sealed (`sealEnvironment`, below) reaches the probe sealed and passes as it is.
      probe: new ReachedProbe(
        new TransportMcpProbe(kernel, {
          childEnvironment: async env => {
            const opened = await vault.childEnvironment('' as FerretId, env);
            return opened.ok ? opened : { ok: false, error: { unknown: opened.error.unknown.map(String) } };
          },
          ...(vault.fetchMinted === undefined
            ? {}
            : {
                fetchMinted: async (secret, request, placement) =>
                  (await vault.fetchMinted?.(secret as SecretName, request, placement)) ?? { kind: 'refused' as const },
              }),
        }),
        checkSpawn,
        async () => await servers.list(),
      ),
      // What this runtime's launch carries from its login and profile: the variables that name no secret, as Runtimes
      // published them, and what the runtime's profile binds to secrets, as REFERENCES (v4 `launchEnvironment.forWrapper`):
      // those fill no `${VAR}` and reach the checked child only through the Vault (`sealEnvironment`); no value is read
      // here. A held sign-in's token is NOT in it: the harness reads it from a variable, and a check presents it through
      // the Vault instead (`credential`). A variable whose value is a stored secret is opaque (below).
      launchEnvironment: async runtime => {
        if (runtime === undefined) return {};
        const published = await runtimes
          .current()
          ?.checkEnvironment?.(runtime as RuntimeId)
          .catch(() => undefined);
        const references = (await accounts()).find(account => account.runtime === runtime)?.secretEnv ?? {};
        return { ...(published?.values ?? {}), ...references };
      },
      opaqueVariables: async runtime =>
        runtime === undefined
          ? []
          : ((
              await runtimes
                .current()
                ?.checkEnvironment?.(runtime as RuntimeId)
                .catch(() => undefined)
            )?.opaque ?? []),
      // The kernel's spawn already hands every child its own `PATH` and `HOME`; this is only what `${VAR}` in a command may
      // fill from (the machine's home). `kernel.hostFacts` is not declared by MCP, so `PATH` is not read here (GAP).
      baseEnvironment: () => mcpCheckBaseEnvironment({ HOME: kernel.paths.home() }),
      sealEnvironment: async (env, runtime) => {
        // For the runtime being checked the Vault also allows the secrets its profile references (Runtimes answers which);
        // otherwise only this plugin's own server entries' secrets. The Vault ignores the ferret for a handle.
        const sealed =
          runtime !== undefined && vault.childEnvironmentForRuntime !== undefined
            ? await vault.childEnvironmentForRuntime(runtime, env)
            : await vault.childEnvironment('mcp-check' as FerretId, env);
        return sealed.ok ? { ok: true, env: sealed.value } : { ok: false, unknown: sealed.error.unknown };
      },
      credential: heldSignIn,
      redactor: { redact: async text => await kernel.redaction.read(scope => scope.text(text)) },
      now: () => kernel.clock.nowMs(),
    });

    // ── adding a server for one ferret ─────────────────────────────────────────────────────────────────────────────
    const session = new SessionMcpService({
      ferrets: {
        get: async id => await inventoryFerret(id),
        list: async () => {
          const all = await ferrets.list();
          return all.map(ferret => ({
            id: ferret.id,
            harness: ferret.harness,
            folder: ferret.folder,
            ...(ferret.runtime === undefined ? {} : { runtime: ferret.runtime }),
          }));
        },
      },
      // G177: a project add lands only at a known root: a registered project or a live managed worktree.
      projectRoots: async () => (await known()).map(folder => folder.root),
      files: new RootMcpProjectFiles(async ferret => {
        const summary = await ferrets.get(ferret as FerretId);
        if (summary === undefined) throw new McpDocumentUnreadable(`no ferret ${ferret}`);
        return { root: kernel.roots.root('work', { ferret: summary.id }), base: summary.folder };
      }),
      // The login add: the item in this plugin's own file, the layer through Runtimes (R-0351, R-0352).
      login: runtimesLoginTarget({
        runtimes: () => runtimes.current(),
        hasItem: name => items().has(name),
        // The person's own Add form: a `${secret:NAME}` env goes into effect at once when the AMBIENT call is the owner
        // (host, or a governed device holding fleet.configure); a ferret's credential never reaches this route
        // (`caller: 'person'`), and any other caller keeps the kernel's hold. The kernel decides; nothing here can.
        writeItem: async (name, patch, ifMatch) =>
          await kernel.config.writeAsCaller(
            MCP_CONFIG,
            name,
            { patch },
            ifMatch === undefined ? undefined : { ifMatch },
          ),
        held: name => {
          const status = kernel.config.fileState(MCP_CONFIG, name);
          return status.state === 'held' ? status.sentences : undefined;
        },
        removeItem: async (name, ifMatch) => await kernel.config.remove(MCP_CONFIG, name, { ifMatch }),
      }),
    });
    async function inventoryFerret(id: string) {
      const ferret = await ferrets.get(id as FerretId);
      return ferret === undefined
        ? undefined
        : {
            id: ferret.id,
            harness: ferret.harness,
            folder: ferret.folder,
            ...(ferret.runtime === undefined ? {} : { runtime: ferret.runtime }),
          };
    }

    // ── what Catalogs asks of the MCP kind (`catalog.items:mcp`) ────────────────────────────────────────────────────
    // A catalog reads every declaration on the machine with what a conversion needs (v4's `inventory.servers()`), writes a
    // project's `.mcp.json` through the kernel's `project-files` root, and installs into a runtime through the item
    // file and the profile layer. The component of a component-scope server is the item as this machine stores it.
    const componentOf = (name: string): McpComponentRecord | undefined => {
      const item = items().get(name);
      return item === undefined
        ? undefined
        : { ...item, harness: item.harness === undefined ? undefined : item.harness === 'codex' ? 'codex' : 'claude' };
    };
    const catalogItems: CatalogMcpProvider = {
      kind: 'mcp',
      sources: async () =>
        (await inventory.servers()).map(server => {
          const name = server.declaration?.name ?? '';
          return {
            id: server.id,
            name,
            scope: server.scope,
            harness: server.harness === 'codex' ? ('codex' as const) : ('claude' as const),
            source: server.source,
            declaration: server.declaration,
            component: server.scope === 'component' ? componentOf(name) : undefined,
          };
        }),
      projectRoots: async () => (await known()).map(folder => folder.root),
      project: new CatalogMcpProjectFile(
        async () => (await known()).map(folder => folder.root),
        root => kernel.roots.root('project-files', { subfolder: root, within: root }),
      ),
      runtime: mcpCatalogRuntime({
        runtimes: () => runtimes.current(),
        items,
        // The person's own install: the kernel decides from the ambient call (host, or a governed device holding
        // fleet.configure); a ferret's credential never reaches the install route.
        writeItem: async (name, patch, ifMatch) =>
          await kernel.config.writeAsCaller(
            MCP_CONFIG,
            name,
            { patch },
            ifMatch === undefined ? undefined : { ifMatch },
          ),
        removeItem: async name => await kernel.config.remove(MCP_CONFIG, name),
      }),
    };

    const api: McpApi = {
      inventory: async ferret => (ferret === undefined ? await inventory.machine() : await inventory.ferret(ferret)),
      check: async (id, ferret) => await check.check(id, ferret),
      connections: async () => await oauth.connections(),
    };

    const signInChanged = (component: string): void => kernel.events.publish(McpSignInChanged, { component });

    return {
      resolvers: {
        'mcp-sign-in': (): readonly string[] => reach.hosts(),
        'mcp-check': (): readonly string[] => checkSpawn.programs(),
      },
      routes: {
        ...inventoryRoutes({
          machine: () => inventory.machine(),
          ferret: id => inventory.ferret(id),
          check: (id, ferret) => check.check(id, ferret),
        }),
        ...oauthRoutes({
          connections: () => oauth.connections(),
          start: (component, request) => oauth.start(component, request),
          complete: async (flow, request) => {
            const done = await oauth.complete(flow, request);
            signInChanged(done.component);
            return done;
          },
          cancel: async flow => oauth.cancel(flow),
          signOut: async component => {
            const out = await oauth.signOut(component);
            signInChanged(component);
            return out;
          },
        }),
        ...sessionRoutes({
          list: id => session.list(id),
          previewProject: (id, request) => session.previewProject(id, request),
          previewLogin: (id, request) => session.previewLogin(id, request),
          addProject: async (id, request) => {
            const added = await session.addProject(id, request);
            kernel.events.publish(McpServerAdded, { name: request.name, scope: 'project' });
            return added;
          },
          addLogin: async (id, request, governance) => {
            const added = await session.addLogin(id, request, governance);
            kernel.events.publish(McpServerAdded, { name: request.name, scope: 'login' });
            return added;
          },
        }),
      },
      provides: { mcp: api },
      hooks: {
        // Catalogs shares and installs MCP servers through this one provider (its `catalog.items` hook, key `mcp`).
        'catalog.items:mcp': catalogItems,
        'launch.parts': () => [{ id: 'mcp', item: launch }],
        // Runtimes' read of the `mcp` components a profile names: this plugin's own items, live, no cache.
        'runtimes.components.mcp:components': mcpComponentSource(items, listener =>
          kernel.config.watch(MCP_CONFIG, listener),
        ),
      },
    };
  },
});
