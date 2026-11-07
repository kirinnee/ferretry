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
import { McpCheckService } from './lib/inventory/check.ts';
import { KnownAndFerretFolders, type McpInventoryFolder, mcpInventoryFolders } from './lib/inventory/folders.ts';
import { McpDocumentUnreadable, McpInventoryService } from './lib/inventory/service.ts';
import { ProjectMcpLaunch } from './lib/inventory/project-sign-in.ts';
import { McpLaunchParts } from './lib/launch-parts.ts';
import { McpOAuthService } from './lib/oauth/service.ts';
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
 * - Runtimes (accounts, profiles, the login scope's write) and Catalogs belong to neighbours whose contracts MCP may
 *   not import yet. The inventory lists the user, project and local servers a ferret's own folder holds; a login add
 *   answers `mcp_runtime_unknown`.
 * - Projects (an optional `uses`) gives the registered roots, so a subfolder of a registered project — a worktree
 *   kept inside it included — is that project, under its root's subject digest, as today. A MANAGED worktree outside
 *   the project (`<home>-worktrees`) is not: Ferrets keeps that registry and its contract has no read of it, so such
 *   a worktree is its own project until one exists. Projects off: every folder is its own project. The project
 *   root's `.mcp.json` is still read only through a ferret folder that holds it (`workRootFor`, MCP's one read
 *   root): from a subfolder, while no ferret works in the project root, nothing is read and nothing renews.
 * - The Vault has no value getter (use, never read). Sign-in writes the ACCESS token by name through `VaultApi.put`;
 *   the refresh token and a registered client secret (the "internal" store) rest in MCP's own sealed document,
 *   `state/mcp/oauth-secrets.json` (today's `mcp-oauth-secrets.json`), opened through the Vault's sealed-document
 *   port and handed to the sign-in service alone. Reading a held ACCESS token back (revoke it at sign-out, a check's
 *   bearer) needs a Vault operation that spends a named secret for this plugin; until that contract change it is not
 *   sent (sign-out revokes with the held refresh token, and answers `revoked: false` when there is none).
 * - Whether a runtime DISABLED a project server is the HARNESS's answer (`approvedProjectServers`, optional `uses`
 *   of Claude Code and Codex), read by the harness plugin from its own home: MCP has no root there. A harness that is
 *   off or does not answer binds nothing (fail closed, `ProjectMcpLaunch`); its sign-ins are still renewed. Both
 *   harness daemon halves are still skeletons, which provide nothing, so until they are ported a launch binds no
 *   project server — the read itself is written and tested in each harness plugin.
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const { ferrets, vault, sealed } = ctx.needs;
    const { claudeCode, codex, projects } = ctx.uses;

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
    const oauth = new McpOAuthService({
      servers: new ConfigMcpServers(items),
      http: new FetchMcpOAuthHttp(kernel.fetch),
      crypto: webCryptoMcpOAuth,
      clock: { now: () => kernel.clock.nowMs() },
      state: new StateMcpOAuthStateStore(kernel.state),
      secrets,
      values: { values: async () => new Map() },
      // Refresh tokens and client secrets: MCP's own sealed document, held by nothing but this service (S8, S174).
      internal: sealedMcpOAuthSecrets(sealed, kernel.state),
    });

    // ── what a ferret's folder holds: one source for the inventory and the launch ──────────────────────────────────
    // Registered projects are the known roots (today's `mcpInventoryFolders`); no managed-worktree read exists here.
    const known = async (): Promise<readonly McpInventoryFolder[]> => {
      const registered = projects.current();
      if (registered === undefined) return [];
      return await mcpInventoryFolders(
        { projects: async () => await registered.list() },
        { list: async () => ({ worktrees: [] }) },
      )();
    };
    const folders = new KnownAndFerretFolders(known, refreshOwners);
    const documents = new RootMcpHarnessDocuments(
      path => workRootFor(path),
      (text, format) => {
        if (format === 'json') return JSON.parse(text) as unknown;
        return NOT_YET('Reading a Codex config.toml');
      },
    );
    const held = async (): Promise<ReadonlySet<SecretName>> =>
      new Set((await vault.names()).map(summary => summary.name));

    // ── every launch: renew the sign-ins it uses, then name them (today's launch environment, `modules/mcp.ts`) ──
    const launch = new McpLaunchParts({
      items,
      held,
      renewal: oauth,
      project: async spec => {
        // The ferret folders are the read roots, so they are read fresh before the launch's own folder is.
        await refreshOwners();
        // The launch is its own account: 5.0 carries the runtime, harness and home on the spec (no Runtimes import).
        // Whether the runtime declined a server is its harness's answer, never a read of its home here (GAP above).
        const agent = spec.runtime ?? spec.ferret;
        return await new ProjectMcpLaunch({
          accounts: async () => [{ runtime: agent, wrapper: agent, harness: spec.harness, home: spec.home }],
          folders,
          documents,
          approvals: harnessProjectApprovals(
            { 'claude-code': () => claudeCode.current(), codex: () => codex.current() },
            spec.harness,
            spec.ferret,
          ),
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
      // Catalogs exposes installs only, Projects' contract is empty, and there is no managed-worktree port.
      // G177: refuse project adds until registered projects and worktrees can supply the known-root set.
      projectRoots: async () => [],
      files: new RootMcpProjectFiles(async ferret => {
        const summary = await ferrets.get(ferret as FerretId);
        if (summary === undefined) throw new McpDocumentUnreadable(`no ferret ${ferret}`);
        return { root: kernel.roots.root('work', { ferret: summary.id }), base: summary.folder };
      }),
      login: {
        runtime: async () => undefined,
        profile: async () => undefined,
        hasItem: async name => items().has(name),
        putItem: async () => NOT_YET('A runtime profile'),
        layerProfile: async () => NOT_YET('A runtime profile'),
      },
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
          addLogin: async (id, request) => {
            const added = await session.addLogin(id, request);
            kernel.events.publish(McpServerAdded, { name: request.name, scope: 'login' });
            return added;
          },
        }),
      },
      provides: { mcp: api },
      hooks: {
        'launch.parts': () => [{ id: 'mcp', item: launch }],
      },
    };
  },
});
