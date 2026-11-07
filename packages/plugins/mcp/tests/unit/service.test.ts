import { describe, it } from 'bun:test';
import type {
  FleetAccountChange,
  FleetAccountChangeView,
  FleetComponentCatalog,
  FleetLayeredProfileCatalog,
  FleetRuntimeCatalog,
  SessionMcpServer,
  SessionView,
} from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import type { FreshStepUpContext } from '../../../src/lib/fleet/catalog-service.ts';
import { McpProjectFileError } from '../../../src/lib/session-mcp/project-file.ts';
import {
  knownProjectRoots,
  McpProjectFileChanged,
  type McpProjectFileReading,
  type McpProjectFiles,
  projectRootFor,
  SessionMcpRefusal,
  SessionMcpService,
  type SessionMcpServiceDeps,
} from '../../../src/lib/session-mcp/service.ts';
import { sessionView } from '../runtime/mounts/support.ts';

/** `${secret:NAME}`, spelled without a string the linter reads as a mistaken template. */
const secretRef = (name: string): string => `\${secret:${name}}`;
const ETAG = 'e'.repeat(64);
const NEW_ETAG = 'f'.repeat(64);
const COMMAND: SessionMcpServer = { transport: 'command', command: 'npx', args: ['acme'], env: {} };
const URL_SERVER: SessionMcpServer = { transport: 'url', url: 'https://mcp.example.com', oauth: true };
const GOVERNANCE = { governed: false } as unknown as CallerGovernance;
const STEP_UP: FreshStepUpContext = { presentation: undefined, spend: () => undefined, agent: false };

class FakeFiles implements McpProjectFiles {
  readonly reads: string[] = [];
  readonly writes: { path: string; text: string; expected: string | null }[] = [];
  constructor(
    private reading: McpProjectFileReading | Error = { text: null, etag: null },
    private readonly writeFailure?: Error,
  ) {}

  async read(path: string): Promise<McpProjectFileReading> {
    this.reads.push(path);
    if (this.reading instanceof Error) throw this.reading;
    return this.reading;
  }

  async replace(path: string, text: string, expected: string | null): Promise<string> {
    if (this.writeFailure !== undefined) throw this.writeFailure;
    this.writes.push({ path, text, expected });
    this.reading = { text, etag: NEW_ETAG };
    return NEW_ETAG;
  }
}

interface FleetCalls {
  proposed: FleetAccountChange[];
  applied: { id: string; governance: CallerGovernance | undefined; stepUp: FreshStepUpContext | undefined }[];
}

const runtime = (name: string, wrapper: string, profile: string) =>
  ({ id: `id-${name}`, name, wrapper, profile }) as unknown as FleetRuntimeCatalog['runtimes'][number];

function fleet(
  options: { profiles?: { name: string; layers: string[] }[]; mcp?: string[]; noMcpGroup?: boolean } = {},
): { fleet: SessionMcpServiceDeps['fleet']; calls: FleetCalls } {
  const calls: FleetCalls = { proposed: [], applied: [] };
  return {
    calls,
    fleet: {
      runtimes: async () =>
        ({
          format: 'version-2',
          runtimes: [runtime('claude-work', 'claude-work-w', 'work'), runtime('orphan', 'orphan', 'gone')],
        }) as FleetRuntimeCatalog,
      profiles: async () =>
        ({
          format: 'version-2',
          profiles: options.profiles ?? [{ name: 'work', layers: ['instructions/base'] }],
        }) as unknown as FleetLayeredProfileCatalog,
      components: async () =>
        ({
          format: 'version-2',
          kinds: options.noMcpGroup
            ? []
            : [
                { kind: 'skills', components: [{ name: 'acme' }] },
                { kind: 'mcp', components: (options.mcp ?? []).map(name => ({ name })) },
              ],
        }) as unknown as FleetComponentCatalog,
      propose: async change => {
        calls.proposed.push(change);
        return { id: `proposal-${calls.proposed.length}` } as FleetAccountChangeView;
      },
      apply: async (id, governance, stepUp) => {
        calls.applied.push({ id, governance, stepUp });
        return { outcome: 'executed', executor: 'setup', summary: 'done' };
      },
    },
  };
}

function service(
  options: {
    views?: SessionView[];
    roots?: string[];
    files?: McpProjectFiles;
    fleet?: SessionMcpServiceDeps['fleet'];
  } = {},
): SessionMcpService {
  const views = options.views ?? [sessionView('s1', { cwd: '/work/repo/packages/cli' })];
  return new SessionMcpService({
    sessions: {
      get: async id => views.find(view => view.config.id === id),
      list: async () => views,
    },
    projectRoots: async () => options.roots ?? ['/work', '/work/repo/'],
    files: options.files ?? new FakeFiles(),
    fleet: options.fleet ?? fleet().fleet,
  });
}

async function refusal(work: Promise<unknown>): Promise<SessionMcpRefusal> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(SessionMcpRefusal);
  return error as SessionMcpRefusal;
}

describe('the known roots a project write may use', () => {
  it('should be the registered projects and the live managed worktrees', async () => {
    // Arrange
    const roots = knownProjectRoots(
      { projects: async () => [{ path: '/work/repo' }] },
      {
        list: async () => ({
          worktrees: [{ path: '/wt/live' }, { path: '/wt/gone', removedAt: '2026-10-01T00:00:00.000Z' }],
        }),
      },
    );

    // Act + Assert
    should(await roots()).deepEqual(['/work/repo', '/wt/live']);
  });

  it('should pick the longest root that holds the folder, and none for a neighbour', () => {
    // Act + Assert
    should(projectRootFor('/work/repo/packages/cli', ['/work', '/work/repo/', '/work/repository'])).equal('/work/repo');
    should(projectRootFor('/work/repo', ['/work/repo'])).equal('/work/repo');
    should(projectRootFor('/work/repo-two', ['/work/repo'])).be.undefined();
    should(projectRootFor('/anything', ['/'])).equal('/');
  });
});

describe('listing a ferret project servers', () => {
  it('should list the file it would write, its etag and its servers', async () => {
    // Arrange
    const files = new FakeFiles({ text: '{"mcpServers":{"b":{"url":"https://b"},"a":{"command":"a"}}}', etag: ETAG });

    // Act
    const listing = await service({ files }).list('s1');

    // Assert
    should(files.reads).deepEqual(['/work/repo/.mcp.json']);
    should(listing).deepEqual({
      project: {
        path: '/work/repo/.mcp.json',
        etag: ETAG,
        servers: [
          { name: 'a', transport: 'command' },
          { name: 'b', transport: 'url' },
        ],
      },
    });
  });

  it('should say why there is no project scope: Codex, an unknown folder, a file it will not read', async () => {
    // Arrange
    const codex = service({ views: [sessionView('s1', { harness: 'codex', cwd: '/work/repo' })] });
    const outside = service({ views: [sessionView('s1', { cwd: '/tmp/scratch' })] });
    const broken = service({ files: new FakeFiles({ text: '{', etag: ETAG }) });
    const linked = service({ files: new FakeFiles(new McpProjectFileError('a link')) });

    // Act
    const listings = await Promise.all([codex, outside, broken, linked].map(async subject => await subject.list('s1')));

    // Assert
    should(listings.map(listing => listing.project)).deepEqual([null, null, null, null]);
    should(listings[0]?.projectUnavailable).match(/^Codex does not read \.mcp\.json/u);
    should(listings[1]?.projectUnavailable).equal(
      "This ferret's folder, /tmp/scratch, is not inside a registered project or a Ferretry worktree, so there is no project file to write. Register the project, or add the server to This login.",
    );
    should(listings[2]?.projectUnavailable).match(/not valid JSON/u);
    should(listings[3]?.projectUnavailable).equal('a link');
  });

  it('should refuse an unknown session and let any other read failure through', async () => {
    // Arrange
    const failing = service({ files: new FakeFiles(new Error('disk on fire')) });

    // Act
    const missing = await refusal(service().list('nobody'));
    const thrown = await failing.list('s1').catch((error: unknown) => error);

    // Assert
    should([missing.status, missing.code, missing.message]).deepEqual([404, 'not-found', 'no session nobody']);
    should((thrown as Error).message).equal('disk on fire');
  });
});

describe('adding to the project file', () => {
  it('should preview a new file as the lines it would add, with no etag', async () => {
    // Act
    const preview = await service().previewProject('s1', { name: 'acme', server: COMMAND });

    // Assert
    should(preview).containDeep({ scope: 'project', path: '/work/repo/.mcp.json', etag: null, replaces: false });
    should(preview.scope === 'project' && preview.diff.every(line => line.kind === 'add')).be.true();
  });

  it('should preview a name already there as a replacement', async () => {
    // Arrange
    const files = new FakeFiles({ text: '{"mcpServers":{"acme":{"command":"old"}}}\n', etag: ETAG });

    // Act
    const preview = await service({ files }).previewProject('s1', { name: 'acme', server: COMMAND });

    // Assert
    should(preview).containDeep({
      etag: ETAG,
      replaces: true,
      diff: [{ kind: 'remove', text: '{"mcpServers":{"acme":{"command":"old"}}}' }],
    });
  });

  it('should write exactly the previewed change against the previewed etag', async () => {
    // Arrange
    const files = new FakeFiles({ text: '{"keep":1}', etag: ETAG });

    // Act
    const added = await service({ files }).addProject('s1', { name: 'acme', server: COMMAND, etag: ETAG });

    // Assert
    should(added).deepEqual({ scope: 'project', name: 'acme', path: '/work/repo/.mcp.json', etag: NEW_ETAG });
    should(files.writes).deepEqual([
      {
        path: '/work/repo/.mcp.json',
        text: '{\n  "keep": 1,\n  "mcpServers": {\n    "acme": {\n      "command": "npx",\n      "args": [\n        "acme"\n      ]\n    }\n  }\n}\n',
        expected: ETAG,
      },
    ]);
  });

  it('should refuse an add with no etag, a stale etag, or a file that moved during the write', async () => {
    // Arrange
    const files = new FakeFiles({ text: '{}', etag: ETAG });
    const racing = new FakeFiles({ text: null, etag: null }, new McpProjectFileChanged());

    // Act
    const noEtag = await refusal(service({ files }).addProject('s1', { name: 'acme', server: COMMAND }));
    const stale = await refusal(service({ files }).addProject('s1', { name: 'acme', server: COMMAND, etag: null }));
    const raced = await refusal(
      service({ files: racing }).addProject('s1', { name: 'acme', server: COMMAND, etag: null }),
    );

    // Assert
    should([noEtag.status, noEtag.code]).deepEqual([400, 'mcp_etag_required']);
    should([stale.status, stale.code, stale.message]).deepEqual([
      409,
      'mcp_file_changed',
      '.mcp.json changed since the preview. Review the new diff, then add the server again.',
    ]);
    should([raced.status, raced.code]).deepEqual([409, 'mcp_file_changed']);
    should(files.writes).be.empty();
  });

  it('should let a write failure that is not a refusal through', async () => {
    // Arrange
    const files = new FakeFiles({ text: null, etag: null }, new Error('read-only file system'));

    // Act
    const thrown = await service({ files })
      .addProject('s1', { name: 'acme', server: COMMAND, etag: null })
      .catch((error: unknown) => error);

    // Assert
    should(thrown).not.be.instanceOf(SessionMcpRefusal);
    should((thrown as Error).message).equal('read-only file system');
  });

  it('should refuse a server the project scope cannot hold, a folder it cannot reach and a file it will not rewrite', async () => {
    // Act
    const signIn = await refusal(service().previewProject('s1', { name: 'acme', server: URL_SERVER }));
    const secret = await refusal(
      service().addProject('s1', { name: 'acme', server: { ...COMMAND, env: { KEY: secretRef('K') } }, etag: null }),
    );
    const codex = await refusal(
      service({ views: [sessionView('s1', { harness: 'codex', cwd: '/work/repo' })] }).previewProject('s1', {
        name: 'acme',
        server: COMMAND,
      }),
    );
    const unreadable = await refusal(
      service({ files: new FakeFiles({ text: '[]', etag: ETAG }) }).previewProject('s1', {
        name: 'acme',
        server: COMMAND,
      }),
    );

    // Assert
    should([signIn.status, signIn.code]).deepEqual([400, 'mcp_server_refused']);
    should([secret.status, secret.code]).deepEqual([400, 'mcp_server_refused']);
    should([codex.status, codex.code]).deepEqual([409, 'mcp_project_unavailable']);
    should([unreadable.status, unreadable.code]).deepEqual([409, 'mcp_file_unreadable']);
  });
});

describe('adding to the login', () => {
  it('should preview the runtime, its profile, a replacement and every ferret that runs as it', async () => {
    // Arrange
    const views = [
      sessionView('s1', { agent: 'claude-work-w' }),
      sessionView('s2', { agent: 'claude-work' }),
      sessionView('s3', { agent: 'someone-else' }),
    ];
    const subject = service({ views, fleet: fleet({ mcp: ['acme'] }).fleet });

    // Act
    const preview = await subject.previewLogin('s1', { name: 'acme', server: URL_SERVER });

    // Assert
    should(preview).deepEqual({ scope: 'login', runtime: 'claude-work', profile: 'work', replaces: true, ferrets: 2 });
  });

  it('should add the component, then append it to the profile, each under the caller governance', async () => {
    // Arrange
    const { fleet: catalog, calls } = fleet();
    const subject = service({ views: [sessionView('s1', { agent: 'claude-work-w' })], fleet: catalog });

    // Act
    const added = await subject.addLogin(
      's1',
      { name: 'acme', server: { ...COMMAND, env: { TOKEN: secretRef('ACME') } } },
      GOVERNANCE,
      STEP_UP,
    );

    // Assert
    should(added).deepEqual({ scope: 'login', name: 'acme', runtime: 'claude-work', profile: 'work' });
    should(calls.proposed).deepEqual([
      {
        kind: 'component.put',
        name: 'acme',
        component: { kind: 'mcp', command: 'npx', args: ['acme'], env: { TOKEN: secretRef('ACME') } },
        create: true,
      },
      { kind: 'profile.put', name: 'work', layers: ['instructions/base', 'mcp/acme'], create: false },
    ]);
    should(calls.applied).deepEqual([
      { id: 'proposal-1', governance: GOVERNANCE, stepUp: STEP_UP },
      { id: 'proposal-2', governance: GOVERNANCE, stepUp: STEP_UP },
    ]);
  });

  it('should replace a component the profile already names without touching the profile', async () => {
    // Arrange
    const { fleet: catalog, calls } = fleet({
      mcp: ['acme'],
      profiles: [{ name: 'work', layers: ['mcp/acme'] }],
    });
    const subject = service({ views: [sessionView('s1', { agent: 'claude-work' })], fleet: catalog });

    // Act
    await subject.addLogin('s1', { name: 'acme', server: URL_SERVER }, GOVERNANCE, STEP_UP);
    await subject.addLogin('s1', { name: 'acme', server: { ...URL_SERVER, oauth: false } }, GOVERNANCE, STEP_UP);

    // Assert
    should(calls.proposed).deepEqual([
      {
        kind: 'component.put',
        name: 'acme',
        component: { kind: 'mcp', url: 'https://mcp.example.com', auth: 'oauth' },
        create: false,
      },
      {
        kind: 'component.put',
        name: 'acme',
        component: { kind: 'mcp', url: 'https://mcp.example.com' },
        create: false,
      },
    ]);
  });

  it('should treat a catalogue with no MCP group as having no such component', async () => {
    // Arrange
    const subject = service({
      views: [sessionView('s1', { agent: 'claude-work' })],
      fleet: fleet({ noMcpGroup: true }).fleet,
    });

    // Act + Assert
    should(await subject.previewLogin('s1', { name: 'acme', server: COMMAND })).containDeep({ replaces: false });
  });

  it('should refuse a runtime the fleet does not have, a missing profile and a raw secret', async () => {
    // Arrange
    const stranger = service({ views: [sessionView('s1', { agent: 'claude-auto' })] });
    const orphan = service({ views: [sessionView('s1', { agent: 'orphan' })] });

    // Act
    const unknown = await refusal(stranger.previewLogin('s1', { name: 'acme', server: COMMAND }));
    const noProfile = await refusal(orphan.addLogin('s1', { name: 'acme', server: COMMAND }, GOVERNANCE, STEP_UP));
    const raw = await refusal(
      stranger.addLogin('s1', { name: 'acme', server: { ...COMMAND, env: { KEY: 'sk-live-1' } } }, GOVERNANCE, STEP_UP),
    );

    // Assert
    should([unknown.status, unknown.code, unknown.message]).deepEqual([
      409,
      'mcp_runtime_unknown',
      "claude-auto is not a runtime in this machine's fleet setup, so there is no login to add the server to. Add it to This project instead.",
    ]);
    should([noProfile.status, noProfile.code, noProfile.message]).deepEqual([
      409,
      'mcp_runtime_unknown',
      'orphan launches with the profile gone, which this machine does not have.',
    ]);
    should([raw.status, raw.code]).deepEqual([400, 'mcp_server_refused']);
  });
});
