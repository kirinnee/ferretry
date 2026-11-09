import type { ConfigCollectionDef, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import type { SecretName, SecretSummary } from '@ferretry/core-vault/contract';
import { MCP_CONFIG, McpServerAdded, McpSignInChanged, type McpApi, type McpItem } from '../contract/index.ts';
import manifest from '../manifest.ts';
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
import { McpCheckService } from './lib/inventory/check.ts';
import {
  KnownAndFerretFolders,
  type McpInventoryFolder,
  managedWorktreeRows,
  mcpInventoryFolders,
} from './lib/inventory/folders.ts';
import { McpDocumentUnreadable, McpInventoryService } from './lib/inventory/service.ts';
import { SignInReach } from './lib/reach.ts';
import { combinedMcpOAuthServers, ProjectMcpLaunch, ProjectMcpOAuthServers } from './lib/inventory/project-sign-in.ts';
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
 * - Catalogs belongs to a neighbour whose contract MCP may not import yet. Runtimes (optional `uses`) answers a login
 *   add: the ferret's runtime and profile are read from it, the item is written to this plugin's own
 *   `config/mcp/<name>.yaml`, and Runtimes adds the one `mcp/<name>` layer under the caller's own standing. Runtimes
 *   off: a login add answers `mcp_runtime_unknown`. A project add lands only at a known root (below), through the
 *   ferret's own `work` root, so a ferret in a SUBFOLDER of a registered project is told in words that the root's file
 *   is outside its folder (declared GAP: it needs the kernel's `project-files` root, the M5 unit).
 * - Projects (an optional `uses`) gives the registered roots and Ferrets' `managedWorktrees()` the managed worktrees
 *   (`<home>-worktrees`), so a subfolder of a registered project, a worktree kept inside it, and a managed worktree
 *   of it are that project, under its root's subject digest, as today. Projects off: a managed worktree belongs to
 *   the repository it was forked from, and every other folder is its own project. The `.mcp.json` at each of those
 *   known roots — that one file, read-only — is read through the kernel's `imports` root scoped to the root
 *   (`adapters/project-root-files.ts`), so a ferret in a subfolder reads it with no ferret in the project root. A
 *   `.mcp.json` that is a link, and a root that is (or sits under) a link, are refused.
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
 * - GAP (declared): the narrowing of the `imports` grant to `<known root>/.mcp.json` is enforced by MCP's adapter
 *   (`adapters/project-root-files.ts`), not by the kernel, which would hand MCP's `imports` root any folder outside
 *   the fence. Closing it needs a kernel root scoped to one file.
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const { ferrets, vault, sealed } = ctx.needs;
    const { claudeCode, projects, runtimes } = ctx.uses;

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
    const projectFile = projectRootMcpFile(root => kernel.roots.root('imports', { subfolder: root }));
    const documents = new RootMcpHarnessDocuments(
      async path => {
        if (path.endsWith(`/${PROJECT_MCP_FILE}`)) {
          const held = projectFile(
            path,
            (await known()).map(folder => folder.root),
          );
          if (held !== undefined) return held;
        }
        return workRootFor(path);
      },
      (text, format) => {
        if (format === 'json') return JSON.parse(text) as unknown;
        return NOT_YET('Reading a Codex config.toml');
      },
    );
    const held = async (): Promise<ReadonlySet<SecretName>> =>
      new Set((await vault.names()).map(summary => summary.name));

    // ── sign-in: the servers (components and projects') and the hosts it may reach ─────────────────────────────────
    // The `mcp-sign-in` network resolver answers only the hosts of the servers listed now, those of the sign-ins on
    // file, and the ones a flow's metadata named (`lib/reach.ts`).
    const reach = new SignInReach({ now: () => kernel.clock.nowMs() });
    const oauth = new McpOAuthService({
      servers: reach.observeServers(
        combinedMcpOAuthServers(new ConfigMcpServers(items), new ProjectMcpOAuthServers(folders, documents)),
      ),
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
    const launch = new McpLaunchParts({
      items,
      held,
      renewal: oauth,
      project: async spec => {
        // The ferret folders are the read roots, so they are read fresh before the launch's own folder is.
        await refreshOwners();
        // The launch is its own account: the spec carries the runtime, harness and home it launches with.
        // Whether the runtime declined a server is its harness's answer, never a read of its home here (GAP above).
        const agent = spec.runtime ?? spec.ferret;
        return await new ProjectMcpLaunch({
          accounts: async () => [{ runtime: agent, wrapper: agent, harness: spec.harness, home: spec.home }],
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
      accounts: async () => [],
      components: async () =>
        [...items()].map(([name, item]) => ({
          name,
          runtimes: [],
          ...(item.auth === undefined ? {} : { auth: item.auth }),
        })),
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
    const check = new McpCheckService({
      inventory,
      probe: new TransportMcpProbe(kernel),
      launchEnvironment: async () => ({}),
      baseEnvironment: () => ({}),
      bearer: async () => undefined,
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
        writeItem: async (name, patch, ifMatch) =>
          await kernel.config.write(MCP_CONFIG, name, { patch }, ifMatch === undefined ? undefined : { ifMatch }),
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

    const api: McpApi = {
      inventory: async ferret => (ferret === undefined ? await inventory.machine() : await inventory.ferret(ferret)),
      check: async (id, ferret) => await check.check(id, ferret),
      connections: async () => await oauth.connections(),
    };

    const signInChanged = (component: string): void => kernel.events.publish(McpSignInChanged, { component });

    return {
      resolvers: { 'mcp-sign-in': (): readonly string[] => reach.hosts() },
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
        'launch.parts': () => [{ id: 'mcp', item: launch }],
        // Runtimes' read of the `mcp` components a profile names: this plugin's own items, live, no cache.
        'runtimes.components.mcp:components': mcpComponentSource(items),
      },
    };
  },
});
