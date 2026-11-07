import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FerretId, FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { LaunchPart, LaunchPartSource, LaunchSpec } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { optionalSecretReference, type SecretName } from '@ferretry/core-vault/contract';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import type { ProjectServerApprovals } from '@ferretry/plugin-claude-code/contract';
import { fakeClaudeCode } from '@ferretry/plugin-claude-code/contract/testing';
import { fakeCodex } from '@ferretry/plugin-codex/contract/testing';
import type { ProjectsApi } from '@ferretry/plugin-projects/contract';
import { fakeProjects } from '@ferretry/plugin-projects/contract/testing';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import { type Instant, ok } from '@ferretry/std';
import { MCP_OAUTH_SECRETS, MCP_OAUTH_STATE, mcpOAuthSecretNames, mcpProjectSubject } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { mcpProjectKey } from '../../daemon/lib/inventory/index.ts';
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

/** `${folder}/<relative>` files, served through a `work` root per ferret folder, as the kernel scopes it. */
function workRoots(folders: ReadonlyMap<FerretId, string>, files: ReadonlyMap<string, string>) {
  return {
    root: (_name: string, scope?: { readonly ferret?: FerretId }): RootHandle => {
      const base = folders.get(scope?.ferret as FerretId) ?? '/nowhere';
      const at = (path: FencedPath) => files.get(path);
      return {
        name: 'work',
        resolve: relative => ok(`${base}/${relative}` as FencedPath),
        stat: async path => {
          const text = at(path);
          return text === undefined
            ? undefined
            : { kind: 'file', size: text.length, modified: '2026-11-07T09:00:00.000Z' as Instant };
        },
        readText: async path => at(path) ?? '',
        readBytes: async () => new Uint8Array(),
        writeText: async () => {
          throw new Error('a launch writes no work file');
        },
        list: async () => [],
        remove: async () => {
          throw new Error('a launch removes no work file');
        },
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
  readonly launch: LaunchPartSource;
}

/**
 * A daemon half with a carried project sign-in for `docs` in `REPO` (due: its access token is 10 s from expiry, a
 * minute on), a lead ferret working in `REPO` itself (the only read root that holds `REPO/.mcp.json`), and the given
 * optional uses.
 */
async function setup(uses: {
  readonly claudeCode?: ReturnType<typeof fakeClaudeCode>;
  readonly codex?: ReturnType<typeof fakeCodex>;
  readonly projects?: ProjectsApi;
}): Promise<Setup> {
  const w = world({ expiresIn: 10 });
  const subject = mcpProjectSubject('docs', mcpProjectKey(REPO));
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
    [LEAD, REPO],
    [WORKER, SUBFOLDER],
    [ferretId('f2'), WORKTREE],
  ]);
  const ferrets = new FakeFerrets();
  for (const [id, folder] of folders) ferrets.add({ id, folder });
  const files = new Map([
    [`${REPO}/.mcp.json`, JSON.stringify({ mcpServers: { docs: { type: 'http', url: w.provider.serverUrl } } })],
  ]);
  const fetched: string[] = [];
  const handle = <Api>(api: Api | undefined) => ({ current: () => api });
  const half = daemon.build?.({
    manifest,
    needs: { ferrets, vault, sealed },
    uses: { claudeCode: handle(uses.claudeCode), codex: handle(uses.codex), projects: handle(uses.projects) },
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
      roots: workRoots(folders, files),
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
    ['off (or still a skeleton)', 'off'],
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

  test('a Codex ferret is handed no project server and renews none for it (not-taken, as today)', async () => {
    // Arrange — the Claude harness would approve; the launch is Codex's, so only Codex is asked.
    const claudeCode = approving();
    const codex = fakeCodex();
    const s = await setup({ claudeCode, codex, projects: await registered() });

    // Act
    const parts = await s.launch.parts(spec(SUBFOLDER, 'codex'));

    // Assert
    expect(codex.approvalQueries).toEqual([{ ferret: WORKER, root: REPO, servers: ['docs'] }]);
    expect(claudeCode.approvalQueries).toEqual([]);
    expect(s.fetched).toEqual([]);
    expect(envOf(parts)).toEqual({});
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
