import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FerretId, FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { LaunchPart, LaunchPartSource, LaunchSpec } from '@ferretry/core-ferrets/contract';
import type { ManagedWorktreeSummary } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { optionalSecretReference, type SecretName } from '@ferretry/core-vault/contract';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import type { ProjectServerApprovals } from '@ferretry/plugin-claude-code/contract';
import { fakeClaudeCode } from '@ferretry/plugin-claude-code/contract/testing';
import type { ProjectId, ProjectInfo, ProjectsApi } from '@ferretry/plugin-projects/contract';
import { fakeProjects } from '@ferretry/plugin-projects/contract/testing';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import { type Instant, ok } from '@ferretry/std';
import { MCP_OAUTH_SECRETS, MCP_OAUTH_STATE, mcpOAuthSecretNames, mcpProjectSubject } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { mcpProjectKey } from '../../daemon/lib/inventory/folders.ts';
import manifest from '../../manifest.ts';
import { leaks, PWA_REDIRECT, world, type World } from './oauth/support.ts';

/**
 * The renewal gaps, through the daemon half as it is wired (lead ruling): a project server's sign-in renews and binds
 * from a worktree or a subfolder of a REGISTERED project (Projects, optional `uses`) under the project root's subject;
 * whether the runtime declined it is the HARNESS's answer (Claude Code / Codex, optional `uses`), never a read of its
 * home by MCP; and a sign-out racing the launch leaves the variable unset instead of refusing. Fake issuer, fake
 * tokens, in-memory folders; no real home is touched.
 */

const REPO = '/work/repo';
const SUBFOLDER = `${REPO}/packages/web`;
const WORKTREE = `${REPO}/.worktrees/feature`;
const LEAD = ferretId('f0');
const WORKER = ferretId('f1');

type Harness = 'claude-code' | 'codex';
const spec = (folder: string, harness: Harness = 'claude-code'): Omit<LaunchSpec, 'parts'> =>
  ({
    ferret: WORKER,
    name: 'worker',
    role: 'helper',
    harness,
    folder,
    home: `/homes/${harness}/f1`,
    instructions: [],
  }) as unknown as Omit<LaunchSpec, 'parts'>;

/** A managed worktree outside the project (`<home>-worktrees`), forked from another checkout of the same repository. */
const MANAGED = '/fy-home-worktrees/repo-feature';
const OTHER_CHECKOUT = '/work/repo-other-checkout';
const COMMON = `${REPO}/.git`;

/** What the fake kernel saw: every root opened (by name and base) and every file read through one. */
interface RootTrace {
  readonly opened: string[];
  readonly reads: string[];
}

/** How the fake disk differs from plain files: what the kernel refuses, and which names are links. */
interface Disk {
  /** Paths every operation on which the kernel's scoped root refuses (a link leaving the root): as `RootError`. */
  readonly refused: ReadonlySet<string>;
  /** Paths that are a LINK to a file inside the same root (the kernel follows it; `lstat` says `symlink`). */
  readonly links: ReadonlySet<string>;
  /** Root folders that are a link to another folder (their real path is not their name). */
  readonly linkedRoots: ReadonlySet<string>;
}

const MODIFIED = '2026-11-07T09:00:00.000Z' as Instant;
const missing = (what: string) => async (): Promise<never> => {
  throw new Error(`a launch does not ${what}`);
};

/**
 * `${base}/<relative>` files, served through a `work` root per ferret folder and an `imports` root per named folder, as
 * the kernel scopes them, with the {@link Disk}'s refusals and links.
 */
function kernelRoots(
  folders: ReadonlyMap<FerretId, string>,
  files: ReadonlyMap<string, string>,
  disk: Disk,
  trace: RootTrace,
) {
  return {
    root: (name: string, scope?: { readonly ferret?: FerretId; readonly subfolder?: string }): RootHandle => {
      const base =
        name === 'imports' ? (scope?.subfolder ?? '/nowhere') : (folders.get(scope?.ferret as FerretId) ?? '/nowhere');
      trace.opened.push(`${name}:${base}`);
      const at = (path: FencedPath) => {
        if (disk.refused.has(path))
          throw Object.assign(new Error('root refused: link_escape'), { refusal: 'link_escape' });
        return files.get(path);
      };
      return {
        name: name as RootHandle['name'],
        internal: false,
        resolve: relative => ok((relative === '' ? base : `${base}/${relative}`) as FencedPath),
        stat: async path => {
          const text = at(path);
          return text === undefined
            ? undefined
            : { kind: 'file', size: text.length, modified: MODIFIED, mode: 0o644, links: 1 };
        },
        lstat: async path => {
          const text = at(path);
          if (text === undefined) return undefined;
          return {
            kind: disk.links.has(path) ? 'symlink' : 'file',
            size: text.length,
            modified: MODIFIED,
            mode: 0o644,
            links: 1,
          };
        },
        realPath: async path => (disk.linkedRoots.has(path) ? (`/elsewhere${path}` as FencedPath) : path),
        readText: async path => {
          trace.reads.push(`${name}:${path}`);
          return at(path) ?? '';
        },
        readBytes: missing('read bytes'),
        readTail: missing('read a tail'),
        writeText: missing('write a file'),
        writeBytes: missing('write a file'),
        copyTree: missing('copy a folder'),
        copyShared: missing('copy a shared folder'),
        linkCredential: missing('link a credential'),
        ensurePrivateDirectory: missing('make a folder'),
        makeDirectory: missing('make a folder'),
        list: missing('list a folder'),
        entries: missing('list a folder'),
        pin: missing('hold a folder'),
        publish: missing('publish'),
        readDurable: missing('readDurable'),
        syncDirectory: missing('syncDirectory'),
        fileIdentity: missing('fileIdentity'),
        remove: missing('remove a file'),
        linkTo: missing('link'),
        setMode: missing('change a mode'),
        rename: missing('move an entry'),
        unlink: missing('remove a link'),
      };
    },
  };
}

interface Setup {
  readonly w: World;
  readonly vault: FakeVault;
  readonly access: SecretName;
  readonly variable: string;
  readonly tokenEndpoint: string;
  readonly fetched: string[];
  readonly trace: RootTrace;
  readonly launch: LaunchPartSource;
}

interface SetupOptions {
  /** The project server's name in `.mcp.json` (default `docs`). */
  readonly server?: string;
  /** Whether a lead ferret works in `REPO` itself (default yes). */
  readonly leadAtRoot?: boolean;
  /** Ferrets' managed worktree registry. */
  readonly managed?: readonly ManagedWorktreeSummary[];
  /** Extra ferrets by folder. */
  readonly more?: readonly (readonly [FerretId, string])[];
  /** Paths the kernel's scoped root refuses. */
  readonly refused?: readonly string[];
  /** Paths that are links inside their root. */
  readonly links?: readonly string[];
  /** Root folders that are links. */
  readonly linkedRoots?: readonly string[];
}

/**
 * A daemon half with a carried project sign-in for the server (default `docs`) in `REPO` (due: its access token is
 * 10 s from expiry, a minute on), ferrets in a subfolder and an in-project worktree, by default a lead ferret working
 * in `REPO` itself, and the given optional uses.
 */
async function setup(
  uses: {
    readonly claudeCode?: ReturnType<typeof fakeClaudeCode>;
    readonly projects?: ProjectsApi;
  },
  options: SetupOptions = {},
): Promise<Setup> {
  const server = options.server ?? 'docs';
  const w = world({ expiresIn: 10 });
  const subject = mcpProjectSubject(server, mcpProjectKey(REPO));
  w.servers.push({ component: subject, url: w.provider.serverUrl, auth: 'oauth', optional: true });
  const flow = await w.service.start(subject, { redirectUri: PWA_REDIRECT });
  await w.service.complete(flow.flowId, { callback: await w.provider.approve(flow.authorizeUrl) });
  const names = mcpOAuthSecretNames(subject, w.provider.serverUrl);
  const carried = w.state.document;
  const record = carried.connections[subject];
  const refreshToken = w.internal.entries.get(names.refresh);
  if (record === undefined || refreshToken === undefined) throw new Error('the sign-in filed nothing');

  const vault = new FakeVault();
  await vault.put(names.access as SecretName, 'fake-carried-access-value');
  const state = {
    read: async (file: { readonly path: string }) => ok(file.path === MCP_OAUTH_STATE.path ? carried : undefined),
    write: async () => undefined,
  };
  const sealed = new FakeSealedDocuments();
  await sealed.open(state as never, MCP_OAUTH_SECRETS).put(names.refresh as never, refreshToken);
  const folders = new Map<FerretId, string>([
    ...(options.leadAtRoot === false ? [] : [[LEAD, REPO] as const]),
    [WORKER, SUBFOLDER],
    [ferretId('f2'), WORKTREE],
    ...(options.more ?? []),
  ]);
  const ferrets = new FakeFerrets();
  for (const [id, folder] of folders) ferrets.add({ id, folder });
  ferrets.setManagedWorktrees(options.managed ?? []);
  // A computed key, so a server named `__proto__` is an own key of the document, as `JSON.parse` makes it.
  const declared = JSON.stringify({ mcpServers: { [server]: { type: 'http', url: w.provider.serverUrl } } });
  const files = new Map([
    [`${REPO}/.mcp.json`, declared],
    [`${MANAGED}/.mcp.json`, declared],
    [`${REPO}/secret.json`, JSON.stringify({ mcpServers: { leak: { type: 'http', url: 'https://example.invalid' } } })],
  ]);
  const fetched: string[] = [];
  const trace: RootTrace = { opened: [], reads: [] };
  const handle = <Api>(api: Api | undefined) => ({ current: () => api });
  const half = daemon.build?.({
    manifest,
    needs: { ferrets, vault, sealed },
    uses: { claudeCode: handle(uses.claudeCode), projects: handle(uses.projects), runtimes: handle(undefined) },
    hooks: {} as never,
    kernel: {
      config: { collection: () => new Map() },
      clock: { nowMs: () => w.clock.at + 60_000 },
      state,
      fetch: {
        request: async (url: string | URL, init?: RequestInit) => {
          fetched.push(String(url));
          return await w.provider.handle(new Request(url, init));
        },
      },
      roots: kernelRoots(
        folders,
        files,
        {
          refused: new Set(options.refused ?? []),
          links: new Set(options.links ?? []),
          linkedRoots: new Set(options.linkedRoots ?? []),
        },
        trace,
      ),
    } as unknown as DaemonContext<typeof manifest>['kernel'],
  } as unknown as DaemonContext<typeof manifest>);
  const hooks = half?.hooks as Record<string, () => readonly { id: string; item: LaunchPartSource }[]> | undefined;
  const launch = hooks?.['launch.parts']?.()[0]?.item;
  if (launch === undefined) throw new Error('MCP contributes no launch.parts source');
  return {
    w,
    vault,
    access: names.access as SecretName,
    variable: names.variable,
    tokenEndpoint: record.tokenEndpoint,
    fetched,
    trace,
    launch,
  };
}

const envOf = (parts: readonly LaunchPart[]): Readonly<Record<string, string>> =>
  Object.assign({}, ...parts.flatMap(part => (part.kind === 'env' ? [part.env] : [])));
const projectParts = (parts: readonly LaunchPart[]) =>
  parts.flatMap(part => (part.kind === 'mcp' && (part.config as { scope?: string }).scope === 'local' ? [part] : []));

const registered = async (): Promise<ProjectsApi> => {
  const projects = fakeProjects();
  await projects.register({ kind: 'existing-folder', path: REPO });
  return projects;
};
/** A registered project with Git attached (the fake registers none), for the common-directory join. */
const project = (path: string, commonDirectory: string): ProjectInfo => ({
  id: '00000000-0000-4000-8000-000000000001' as ProjectId,
  name: 'repo',
  path,
  source: 'existing-folder',
  createdAt: '2026-11-07T09:00:00.000Z' as Instant,
  git: { commonDirectory },
});
const projectsWith = (list: readonly ProjectInfo[]): ProjectsApi => ({
  list: async () => list,
  find: async id => list.find(entry => entry.id === id),
  register: async () => {
    throw new Error('a launch registers no project');
  },
  remove: async () => {
    throw new Error('a launch removes no project');
  },
});
const managedRow = (path: string, repositoryRoot: string, commonDirectory: string): ManagedWorktreeSummary => ({
  path,
  branch: 'feature',
  repositoryRoot,
  commonDirectory,
  relativeCwd: '',
  createdAt: '2026-11-07T09:00:00.000Z',
  initialHead: 'abc123',
  branchPreexisted: false,
});
const approving = () => {
  const claudeCode = fakeClaudeCode();
  claudeCode.setApprovals(query => ({
    state: 'read',
    servers: Object.fromEntries(query.servers.map(name => [name, 'approved' as const])),
  }));
  return claudeCode;
};

const logged: string[] = [];
const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
beforeEach(() => {
  logged.length = 0;
  for (const level of ['log', 'info', 'warn', 'error'] as const)
    console[level] = (...args: unknown[]) => void logged.push(args.map(arg => String(arg)).join(' '));
});
afterEach(() => Object.assign(console, originals));

describe('a registered project’s sign-in, from a worktree or a subfolder (Projects known roots)', () => {
  test.each([
    ['a subfolder', SUBFOLDER],
    ['a worktree kept inside the project', WORKTREE],
  ])('%s of a registered project renews and binds the project root’s sign-in, as today', async (_what, folder) => {
    // Arrange
    const claudeCode = approving();
    const s = await setup({ claudeCode, projects: await registered() });

    // Act
    const parts = await s.launch.parts(spec(folder));

    // Assert — renewed at the record's own token endpoint, under the PROJECT ROOT's subject…
    expect(s.fetched).toEqual([s.tokenEndpoint]);
    expect(s.w.provider.tokenRequests.at(-1)?.get('grant_type')).toBe('refresh_token');
    // …the harness was asked about the project root's servers, for this ferret…
    expect(claudeCode.approvalQueries).toEqual([{ ferret: WORKER, root: REPO, servers: ['docs'] }]);
    // …and bound by an optional reference only, with its local-scope entry for the project root.
    expect(envOf(parts)).toEqual({ [s.variable]: optionalSecretReference(s.access) });
    expect(projectParts(parts).map(part => (part.config as { project?: string }).project)).toEqual([REPO]);
    expect(leaks(s.w.provider, parts, logged)).toEqual([]);
    expect(JSON.stringify(parts)).not.toContain('fake-carried-access-value');
  });

  test('with Projects off, a subfolder is its own project: the registered project’s sign-in is not matched', async () => {
    // Arrange
    const claudeCode = approving();
    const s = await setup({ claudeCode });

    // Act
    const parts = await s.launch.parts(spec(SUBFOLDER));

    // Assert
    expect(s.fetched).toEqual([]);
    expect(envOf(parts)).toEqual({});
    expect(projectParts(parts)).toEqual([]);
  });
});

describe('approvals through each harness (MCP never reads the harness home)', () => {
  test('a server the Claude Code harness disabled for this ferret is renewed, but binds nothing', async () => {
    // Arrange
    const claudeCode = fakeClaudeCode();
    claudeCode.setApprovals(() => ({ state: 'read', servers: { docs: 'disabled' } }));
    const s = await setup({ claudeCode, projects: await registered() });

    // Act
    const parts = await s.launch.parts(spec(SUBFOLDER));

    // Assert
    expect(s.fetched).toEqual([s.tokenEndpoint]);
    expect(envOf(parts)).toEqual({});
    expect(projectParts(parts)).toEqual([]);
  });

  test.each<[string, (() => ProjectServerApprovals) | 'off']>([
    ['off', 'off'],
    ['unable to read its own home', () => ({ state: 'unreadable', reason: 'settings.json is not valid JSON.' })],
    [
      'throwing',
      () => {
        throw new Error('Claude Code is not built yet in this version of Ferretry.');
      },
    ],
  ])(
    'a Claude Code harness that is %s binds nothing (fail closed), and the launch goes ahead',
    async (_what, answer) => {
      // Arrange
      const claudeCode = answer === 'off' ? undefined : fakeClaudeCode();
      if (claudeCode !== undefined && answer !== 'off') claudeCode.setApprovals(answer);
      const s = await setup({ ...(claudeCode === undefined ? {} : { claudeCode }), projects: await registered() });

      // Act
      const parts = await s.launch.parts(spec(SUBFOLDER));

      // Assert
      expect(s.fetched).toEqual([s.tokenEndpoint]);
      expect(envOf(parts)).toEqual({});
      expect(projectParts(parts)).toEqual([]);
    },
  );

  test('a Codex launch, with Codex unbound (its 5.0 state), is handed no project server and renews none (not-taken)', async () => {
    // Arrange — the Claude harness would approve; the launch is Codex's, and no Codex port is bound at all.
    const claudeCode = approving();
    const s = await setup({ claudeCode, projects: await registered() });

    // Act
    const parts = await s.launch.parts(spec(SUBFOLDER, 'codex'));

    // Assert — no fetch to any token endpoint, an empty env, no local entry, and Claude is never asked.
    expect(s.fetched).toEqual([]);
    expect(s.w.provider.tokenRequests.filter(request => request.get('grant_type') === 'refresh_token')).toEqual([]);
    expect(envOf(parts)).toEqual({});
    expect(projectParts(parts)).toEqual([]);
    expect(claudeCode.approvalQueries).toEqual([]);
  });
});

describe('a server whose name is an Object.prototype key (__proto__, constructor, toString)', () => {
  const NAMES = ['__proto__', 'constructor', 'toString'] as const;
  /** A harness answer built from entries, so `__proto__` is an own key, as the Claude reader now builds it. */
  const answering = (answer: (name: string) => readonly (readonly [string, 'approved' | 'pending' | 'disabled'])[]) => {
    const claudeCode = fakeClaudeCode();
    claudeCode.setApprovals(query => ({
      state: 'read',
      servers: Object.fromEntries(query.servers.flatMap(name => answer(name))),
    }));
    return claudeCode;
  };

  test.each(NAMES)('a server named %s that the harness DISABLED is renewed but not bound', async server => {
    // Arrange
    const claudeCode = answering(name => [[name, 'disabled']]);
    const s = await setup({ claudeCode, projects: await registered() }, { server });

    // Act
    const parts = await s.launch.parts(spec(SUBFOLDER));

    // Assert
    expect(claudeCode.approvalQueries).toEqual([{ ferret: WORKER, root: REPO, servers: [server] }]);
    expect(envOf(parts)).toEqual({});
    expect(projectParts(parts)).toEqual([]);
  });

  test.each(NAMES)('a server named %s that the harness gave NO answer for is not bound', async server => {
    // Arrange — a read with no decision of its own for that name: `decided[name]` would be Object.prototype's.
    const claudeCode = answering(() => []);
    const s = await setup({ claudeCode, projects: await registered() }, { server });

    // Act
    const parts = await s.launch.parts(spec(SUBFOLDER));

    // Assert
    expect(envOf(parts)).toEqual({});
    expect(projectParts(parts)).toEqual([]);
  });

  test.each(NAMES)('a server named %s that the harness APPROVED is bound, under its own name', async server => {
    // Arrange
    const claudeCode = answering(name => [[name, 'approved']]);
    const s = await setup({ claudeCode, projects: await registered() }, { server });

    // Act
    const parts = await s.launch.parts(spec(SUBFOLDER));

    // Assert — an own entry (not the prototype), one optional reference, and no value anywhere.
    expect(envOf(parts)).toEqual({ [s.variable]: optionalSecretReference(s.access) });
    expect(
      projectParts(parts).map(part => [
        part.kind === 'mcp' ? part.name : '',
        (part.config as { project?: string }).project,
      ]),
    ).toEqual([[server, REPO]]);
    expect(JSON.stringify(parts)).not.toContain('fake-carried-access-value');
  });
});

describe('the .mcp.json at a known root, read through the kernel (lead ruling (B))', () => {
  test('a ferret in a subfolder with NO ferret at the project root still reads the root’s .mcp.json, and binds', async () => {
    // Arrange
    const claudeCode = approving();
    const s = await setup({ claudeCode, projects: await registered() }, { leadAtRoot: false });

    // Act
    const parts = await s.launch.parts(spec(SUBFOLDER));

    // Assert — renewed and bound, and the ONLY file read is the project root's .mcp.json, through `imports`.
    expect(s.fetched).toEqual([s.tokenEndpoint]);
    expect(envOf(parts)).toEqual({ [s.variable]: optionalSecretReference(s.access) });
    expect(projectParts(parts).map(part => (part.config as { project?: string }).project)).toEqual([REPO]);
    expect(s.trace.reads).toEqual([`imports:${REPO}/.mcp.json`]);
    expect(s.trace.opened.filter(root => root.startsWith('imports:'))).toEqual([`imports:${REPO}`]);
  });

  test('a .mcp.json the kernel’s scoped root refuses (a link out of the root) is not read: nothing renews or binds', async () => {
    // Arrange
    const s = await setup(
      { claudeCode: approving(), projects: await registered() },
      { leadAtRoot: false, refused: [`${REPO}/.mcp.json`] },
    );

    // Act
    const parts = await s.launch.parts(spec(SUBFOLDER));

    // Assert
    expect(s.fetched).toEqual([]);
    expect(envOf(parts)).toEqual({});
    expect(s.trace.reads).toEqual([]);
  });

  test('a project root that is a link is the kernel’s anchor: its .mcp.json is read and bound as any root’s', async () => {
    // Arrange
    const s = await setup(
      { claudeCode: approving(), projects: await registered() },
      { leadAtRoot: false, linkedRoots: [REPO] },
    );

    // Act
    const parts = await s.launch.parts(spec(SUBFOLDER));

    // Assert
    expect(s.fetched).toEqual([s.tokenEndpoint]);
    expect(envOf(parts)).toEqual({ [s.variable]: optionalSecretReference(s.access) });
    expect(s.trace.reads).toEqual([`imports:${REPO}/.mcp.json`]);
  });

  test.each<[string, SetupOptions]>([
    ['a .mcp.json that is a link (even to a file inside the root)', { links: [`${REPO}/.mcp.json`] }],
  ])('%s is refused: nothing is read, renewed or bound', async (_what, disk) => {
    // Arrange
    const s = await setup({ claudeCode: approving(), projects: await registered() }, { leadAtRoot: false, ...disk });

    // Act
    const parts = await s.launch.parts(spec(SUBFOLDER));

    // Assert
    expect(s.fetched).toEqual([]);
    expect(envOf(parts)).toEqual({});
    expect(s.trace.reads).toEqual([]);
  });

  test('with Projects off and no ferret at the root, nothing is read at the root at all', async () => {
    // Arrange
    const s = await setup({ claudeCode: approving() }, { leadAtRoot: false });

    // Act
    const parts = await s.launch.parts(spec(SUBFOLDER));

    // Assert — the subfolder is its own project; no `imports` root is opened.
    expect(s.fetched).toEqual([]);
    expect(envOf(parts)).toEqual({});
    expect(s.trace.opened.filter(root => root.startsWith('imports:'))).toEqual([]);
  });

  test('a MANAGED worktree maps to its project (joined by common directory) and binds the project’s sign-in', async () => {
    // Arrange — forked from another checkout; only the common directory says it is REPO's project.
    const claudeCode = approving();
    const projects = projectsWith([project(REPO, COMMON)]);
    const s = await setup(
      { claudeCode, projects },
      { leadAtRoot: false, managed: [managedRow(MANAGED, OTHER_CHECKOUT, COMMON)], more: [[ferretId('f3'), MANAGED]] },
    );

    // Act
    const parts = await s.launch.parts({ ...spec(MANAGED), ferret: ferretId('f3') } as Omit<LaunchSpec, 'parts'>);

    // Assert — the REPO subject renews and binds; the worktree's own .mcp.json is the one file read.
    expect(s.fetched).toEqual([s.tokenEndpoint]);
    expect(claudeCode.approvalQueries).toEqual([{ ferret: ferretId('f3'), root: MANAGED, servers: ['docs'] }]);
    expect(envOf(parts)).toEqual({ [s.variable]: optionalSecretReference(s.access) });
    expect(s.trace.reads).toEqual([`imports:${MANAGED}/.mcp.json`]);
  });

  test('a REMOVED managed worktree is not a known root: no project, nothing read, nothing bound', async () => {
    // Arrange
    const s = await setup(
      { claudeCode: approving(), projects: projectsWith([project(REPO, COMMON)]) },
      {
        leadAtRoot: false,
        managed: [{ ...managedRow(MANAGED, OTHER_CHECKOUT, COMMON), removedAt: '2026-11-07T10:00:00.000Z' }],
      },
    );

    // Act
    const parts = await s.launch.parts(spec(MANAGED));

    // Assert
    expect(s.fetched).toEqual([]);
    expect(envOf(parts)).toEqual({});
    expect(s.trace.reads).toEqual([]);
  });
});

describe('a sign-out racing a launch', () => {
  test('a sign-out between held() and the launch opening the env leaves the variable unset; the launch starts', async () => {
    // Arrange — the parts were decided while the token was held.
    const s = await setup({ claudeCode: approving(), projects: await registered() });
    const parts = await s.launch.parts(spec(SUBFOLDER));
    const env = envOf(parts);
    expect(env).toEqual({ [s.variable]: optionalSecretReference(s.access) });

    // Act — the owner signs out before Ferrets asks the Vault to open the references.
    await s.vault.remove(s.access);
    const opened = await s.vault.childEnvironment(WORKER, { ...env, FY_FERRET_ID: WORKER });

    // Assert — not refused; the variable is simply not there, and nothing names a value.
    expect(opened.ok).toBe(true);
    if (opened.ok) expect([...opened.value.names]).toEqual(['FY_FERRET_ID']);
    expect(leaks(s.w.provider, parts, logged, opened)).toEqual([]);
  });

  test('while the token is still held, the same env opens with the variable set', async () => {
    // Arrange
    const s = await setup({ claudeCode: approving(), projects: await registered() });
    const env = envOf(await s.launch.parts(spec(SUBFOLDER)));

    // Act
    const opened = await s.vault.childEnvironment(WORKER, env);

    // Assert — names only on the handle, never the value.
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect([...opened.value.names]).toEqual([s.variable]);
      expect(JSON.stringify(opened.value)).not.toContain('fake-carried-access-value');
    }
  });
});
