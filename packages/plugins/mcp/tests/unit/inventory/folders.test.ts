/**
 * Which project a folder is in — and the property it exists for: the subject a row of the inventory
 * offers is a subject the sign-in list holds, and the one a launch delivers, for every folder a ferret can
 * work in. Before `KnownAndFerretFolders`, a ferret in a folder no project was registered for was listed
 * under its own folder's key (`phoebe..048c658abfb9`) while the sign-in knew only registered folders.
 */
import { describe, it } from 'bun:test';
import { mcpOAuthSecretNames, mcpProjectSubject, type SecretName } from '@ferretry/protocol';
import should from 'should';
import {
  type ClaudeLocalScope,
  combinedMcpOAuthServers,
  type McpInventoryFolder,
  McpInventoryService,
  mcpFolderFor,
  mcpFolderSubject,
  mcpProjectKey,
  ProjectMcpLaunch,
  ProjectMcpOAuthServers,
} from '../../../src/lib/mcp-inventory/index.ts';
import { McpOAuthRefusal, McpOAuthService } from '../../../src/lib/mcp-oauth/index.ts';
import { PWA_REDIRECT, testCrypto, world } from '../mcp-oauth/support.ts';
import { sessionView } from '../runtime/mounts/support.ts';
import { ACCOUNTS, FOLDERS, knownFolders, MemoryDocuments, PROJECT, WORKTREE } from './support.ts';

const LONE = '/Users/someone/Workspace/work/PE';
const NESTED = `${LONE}/tools/inner`;
const OTHER = '/srv/other';

describe('mcpFolderFor', () => {
  it('should put a folder in the longest known root that contains it', () => {
    // Arrange
    const known: readonly McpInventoryFolder[] = [...FOLDERS, { root: `${PROJECT}/packages/web`, project: PROJECT }];

    // Act / Assert
    should(mcpFolderFor(PROJECT, known)).equal(known[0]);
    should(mcpFolderFor(`${PROJECT}/src/deep/`, known)).equal(known[0]);
    should(mcpFolderFor(`${WORKTREE}/src`, known)).equal(known[1]);
    should(mcpFolderFor(`${PROJECT}/packages/web/src`, known)).equal(known[2]);
  });

  it('should make a folder in no known root a project of its own, spelled once', () => {
    // Act / Assert
    should(mcpFolderFor(`${LONE}/`, FOLDERS)).deepEqual({ root: LONE, project: LONE });
    should(mcpFolderFor(`${LONE}//./`, FOLDERS)).deepEqual({ root: LONE, project: LONE });
    // A lexical compare: a sibling sharing a prefix is not inside the project.
    should(mcpFolderFor(`${PROJECT}-old`, FOLDERS)).deepEqual({ root: `${PROJECT}-old`, project: `${PROJECT}-old` });
  });
});

describe('KnownAndFerretFolders', () => {
  it('should list the known folders, then each ferret folder in none of them, once', async () => {
    // Arrange
    const folders = knownFolders(FOLDERS, [`${PROJECT}/src`, LONE, `${LONE}/`, NESTED, WORKTREE, OTHER]);

    // Act
    const listed = await folders.list();

    // Assert — a ferret inside a known folder adds nothing; a nested lone folder is its own project,
    // exactly as `forCwd` reads it before any ferret exists there.
    should(listed).deepEqual([
      ...FOLDERS,
      { root: LONE, project: LONE },
      { root: NESTED, project: NESTED },
      { root: OTHER, project: OTHER },
    ]);
    should(await folders.forCwd(NESTED)).deepEqual({ root: NESTED, project: NESTED });
    should(await knownFolders(FOLDERS).forCwd(`${LONE}/tools/inner`)).deepEqual({ root: NESTED, project: NESTED });
  });
});

/** A web server in every folder, so every folder offers a subject. */
function machineFiles(): Map<string, unknown> {
  const files = new Map<string, unknown>([
    ['/fy/fleet/homes/claude-work-id/.claude.json', {}],
    ['/fy/fleet/homes/claude-work-id/settings.json', {}],
  ]);
  for (const root of [PROJECT, WORKTREE, LONE, NESTED, OTHER])
    files.set(`${root}/.mcp.json`, { mcpServers: { phoebe: { type: 'http', url: 'https://phoebe.example.com/mcp' } } });
  return files;
}

const NO_LOCAL_SCOPE: ClaudeLocalScope = { reconcile: async () => undefined };

describe('one derivation of a project server’s subject', () => {
  const ferrets = [LONE, NESTED, `${PROJECT}/src`, `${WORKTREE}/lib`, `${OTHER}/`];

  for (const cwd of ferrets)
    it(`should offer, list and deliver one subject for a ferret in ${cwd}`, async () => {
      // Arrange
      const documents = new MemoryDocuments(machineFiles());
      const folders = knownFolders(FOLDERS, ferrets);
      const inventory = new McpInventoryService({
        accounts: async () => ACCOUNTS,
        components: async () => [],
        folders,
        connections: async () => [],
        documents,
        sessions: { get: async () => sessionView('s1', { cwd, agent: '/fy/fleet/bin/claude-work' }) },
      });
      const renewed: SecretName[] = [];
      const launch = new ProjectMcpLaunch({
        accounts: async () => ACCOUNTS,
        folders,
        documents,
        secrets: { values: async () => new Map() },
        renewal: { refreshForLaunch: async names => void renewed.push(...names) },
        localScope: NO_LOCAL_SCOPE,
      });

      // Act
      const offered = (await inventory.session('s1')).servers.flatMap(server =>
        server.signIn === undefined ? [] : [server.signIn.subject],
      );
      const machine = (await inventory.machine()).servers.flatMap(server =>
        server.signIn === undefined ? [] : [server.signIn.subject],
      );
      const listed = (await new ProjectMcpOAuthServers(folders, documents).list()).map(server => server.component);
      await launch.forLaunch('/fy/fleet/bin/claude-work', cwd);

      // Assert
      should(offered).have.length(1);
      const subject = offered[0] as string;
      should(subject).equal(mcpFolderSubject(await folders.forCwd(cwd), 'phoebe'));
      should(listed).containEql(subject);
      should(machine).containEql(subject);
      should(renewed).deepEqual([mcpOAuthSecretNames(subject, 'https://phoebe.example.com/mcp').access]);
    });

  it('should share one subject across a project and its worktree, and none with a lone folder', async () => {
    // Arrange
    const folders = knownFolders(FOLDERS, [LONE]);

    // Act
    const [project, worktree, lone] = await Promise.all(
      [PROJECT, WORKTREE, LONE].map(async cwd => mcpFolderSubject(await folders.forCwd(cwd), 'phoebe')),
    );

    // Assert
    should(worktree).equal(project);
    should(lone).equal(mcpProjectSubject('phoebe', mcpProjectKey(LONE)));
    should(lone).not.equal(project);
  });
});

describe('a sign-in for a subject no list holds', () => {
  function signIn(files: Map<string, unknown>, ferrets: readonly string[]) {
    const w = world();
    return new McpOAuthService({
      servers: combinedMcpOAuthServers(
        { list: async () => [] },
        new ProjectMcpOAuthServers(knownFolders(FOLDERS, ferrets), new MemoryDocuments(files)),
      ),
      http: w.http,
      crypto: testCrypto,
      clock: w.clock,
      state: w.state,
      secrets: w.secrets,
      values: w.secrets,
      internal: w.internal,
    });
  }

  const refusal = async (start: Promise<unknown>): Promise<McpOAuthRefusal> => {
    try {
      await start;
    } catch (error) {
      if (error instanceof McpOAuthRefusal) return error;
      throw error;
    }
    throw new Error('the sign-in started');
  };

  it('should name the project file when the project is known and no longer declares the server', async () => {
    // Arrange
    const service = signIn(machineFiles(), [LONE]);

    // Act
    const refused = await refusal(
      service.start(mcpProjectSubject('gone', mcpProjectKey(LONE)), { redirectUri: PWA_REDIRECT }),
    );

    // Assert
    should(refused.code).equal('mcp_auth_unknown_component');
    should(refused.message).equal(
      `There is no web MCP server named “gone” in ${LONE}/.mcp.json any more. Read the list again.`,
    );
  });

  it('should say a project is not known here, with its key, and keep the plain sentence for a component', async () => {
    // Arrange
    const service = signIn(machineFiles(), []);
    const key = mcpProjectKey(LONE);

    // Act
    const project = await refusal(service.start(mcpProjectSubject('phoebe', key), { redirectUri: PWA_REDIRECT }));
    const component = await refusal(service.start('nowhere', { redirectUri: PWA_REDIRECT }));

    // Assert
    should(project.message).equal(
      `“phoebe” belongs to a project (${key}) Ferretry does not know on this machine any more: none of the 2 project, worktree and ferret folders it knows is that project. Read the list again from the ferret it belongs to.`,
    );
    should(component.message).equal('There is no MCP server named “nowhere” here.');
  });
});
