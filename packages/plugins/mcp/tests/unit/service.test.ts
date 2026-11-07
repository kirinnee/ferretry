import { describe, it } from 'bun:test';
import should from 'should';
import type { McpItem, SessionMcpServer } from '../../contract/index.ts';
import type { McpFerretView } from '../../daemon/lib/inventory/service.ts';
import { McpProjectFileError } from '../../daemon/lib/session/project-file.ts';
import {
  type McpLoginProfile,
  type McpLoginRuntime,
  type McpLoginTarget,
  McpProjectFileChanged,
  type McpProjectFileReading,
  type McpProjectFiles,
  projectRootFor,
  SessionMcpRefusal,
  SessionMcpService,
} from '../../daemon/lib/session/service.ts';

/** `${secret:NAME}`, spelled without a string the linter reads as a mistaken template. */
const secretRef = (name: string): string => `\${secret:${name}}`;
const ETAG = 'e'.repeat(64);
const NEW_ETAG = 'f'.repeat(64);
const COMMAND: SessionMcpServer = { transport: 'command', command: 'npx', args: ['acme'], env: {} };
const URL_SERVER: SessionMcpServer = { transport: 'url', url: 'https://mcp.example.com', oauth: true };

const ferret = (id: string, extra: Partial<McpFerretView> = {}): McpFerretView => ({
  id,
  harness: 'claude-code',
  folder: '/work/repo/packages/cli',
  runtime: 'claude-work',
  ...extra,
});

class FakeFiles implements McpProjectFiles {
  readonly reads: string[] = [];
  readonly writes: { ferret: string; path: string; text: string; expected: string | null }[] = [];
  constructor(
    private reading: McpProjectFileReading | Error = { text: null, etag: null },
    private readonly writeFailure?: Error,
  ) {}

  async read(_ferret: string, path: string): Promise<McpProjectFileReading> {
    this.reads.push(path);
    if (this.reading instanceof Error) throw this.reading;
    return this.reading;
  }

  async replace(ferretId: string, path: string, text: string, expected: string | null): Promise<string> {
    if (this.writeFailure !== undefined) throw this.writeFailure;
    this.writes.push({ ferret: ferretId, path, text, expected });
    this.reading = { text, etag: NEW_ETAG };
    return NEW_ETAG;
  }
}

interface LoginCalls {
  puts: { name: string; item: McpItem; create: boolean }[];
  layered: { profile: string; layers: readonly string[] }[];
}

function login(
  options: { profiles?: McpLoginProfile[]; items?: string[]; runtimes?: McpLoginRuntime[] } = {},
): { login: McpLoginTarget; calls: LoginCalls } {
  const calls: LoginCalls = { puts: [], layered: [] };
  const runtimes = options.runtimes ?? [
    { name: 'claude-work', profile: 'work' },
    { name: 'orphan', profile: 'gone' },
  ];
  const profiles = options.profiles ?? [{ name: 'work', layers: ['instructions/base'] }];
  return {
    calls,
    login: {
      runtime: async name => runtimes.find(candidate => candidate.name === name),
      profile: async name => profiles.find(candidate => candidate.name === name),
      hasItem: async name => (options.items ?? []).includes(name),
      putItem: async (name, item, create) => {
        calls.puts.push({ name, item, create });
      },
      layerProfile: async (profile, layers) => {
        calls.layered.push({ profile, layers });
      },
    },
  };
}

function service(
  options: { views?: McpFerretView[]; roots?: string[]; files?: McpProjectFiles; login?: McpLoginTarget } = {},
): SessionMcpService {
  const views = options.views ?? [ferret('s1')];
  return new SessionMcpService({
    ferrets: {
      get: async id => views.find(view => view.id === id),
      list: async () => views,
    },
    projectRoots: async () => options.roots ?? ['/work', '/work/repo/'],
    files: options.files ?? new FakeFiles(),
    login: options.login ?? login().login,
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
  it('should pick the longest root that holds the folder, and none for a neighbour', () => {
    should(projectRootFor('/work/repo/packages/cli', ['/work', '/work/repo/', '/work/repository'])).equal('/work/repo');
    should(projectRootFor('/work/repo', ['/work/repo'])).equal('/work/repo');
    should(projectRootFor('/work/repo-two', ['/work/repo'])).be.undefined();
    should(projectRootFor('/anything', ['/'])).equal('/');
  });
});

describe('listing a ferret project servers', () => {
  it('should list the file it would write, its etag and its servers', async () => {
    const files = new FakeFiles({ text: '{"mcpServers":{"b":{"url":"https://b"},"a":{"command":"a"}}}', etag: ETAG });

    const listing = await service({ files }).list('s1');

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
    const codex = service({ views: [ferret('s1', { harness: 'codex', folder: '/work/repo' })] });
    const outside = service({ views: [ferret('s1', { folder: '/tmp/scratch' })] });
    const broken = service({ files: new FakeFiles({ text: '{', etag: ETAG }) });
    const linked = service({ files: new FakeFiles(new McpProjectFileError('a link')) });

    const listings = await Promise.all([codex, outside, broken, linked].map(async subject => await subject.list('s1')));

    should(listings.map(listing => listing.project)).deepEqual([null, null, null, null]);
    should(listings[0]?.projectUnavailable).match(/^Codex does not read \.mcp\.json/u);
    should(listings[1]?.projectUnavailable).equal(
      "This ferret's folder, /tmp/scratch, is not inside a registered project or a Ferretry worktree, so there is no project file to write. Register the project, or add the server to This login.",
    );
    should(listings[2]?.projectUnavailable).match(/not valid JSON/u);
    should(listings[3]?.projectUnavailable).equal('a link');
  });

  it('should refuse an unknown ferret and let any other read failure through', async () => {
    const failing = service({ files: new FakeFiles(new Error('disk on fire')) });

    const missing = await refusal(service().list('nobody'));
    const thrown = await failing.list('s1').catch((error: unknown) => error);

    should([missing.status, missing.code, missing.message]).deepEqual([404, 'not-found', 'no ferret nobody']);
    should((thrown as Error).message).equal('disk on fire');
  });
});

describe('adding to the project file', () => {
  it('should preview a new file as the lines it would add, with no etag', async () => {
    const preview = await service().previewProject('s1', { name: 'acme', server: COMMAND });

    should(preview).containDeep({ scope: 'project', path: '/work/repo/.mcp.json', etag: null, replaces: false });
    should(preview.scope === 'project' && preview.diff.every(line => line.kind === 'add')).be.true();
  });

  it('should preview a name already there as a replacement', async () => {
    const files = new FakeFiles({ text: '{"mcpServers":{"acme":{"command":"old"}}}\n', etag: ETAG });

    const preview = await service({ files }).previewProject('s1', { name: 'acme', server: COMMAND });

    should(preview).containDeep({
      etag: ETAG,
      replaces: true,
      diff: [{ kind: 'remove', text: '{"mcpServers":{"acme":{"command":"old"}}}' }],
    });
  });

  it('should write exactly the previewed change against the previewed etag', async () => {
    const files = new FakeFiles({ text: '{"keep":1}', etag: ETAG });

    const added = await service({ files }).addProject('s1', { name: 'acme', server: COMMAND, etag: ETAG });

    should(added).deepEqual({ scope: 'project', name: 'acme', path: '/work/repo/.mcp.json', etag: NEW_ETAG });
    should(files.writes).deepEqual([
      {
        ferret: 's1',
        path: '/work/repo/.mcp.json',
        text: '{\n  "keep": 1,\n  "mcpServers": {\n    "acme": {\n      "command": "npx",\n      "args": [\n        "acme"\n      ]\n    }\n  }\n}\n',
        expected: ETAG,
      },
    ]);
  });

  it('should refuse an add with no etag, a stale etag, or a file that moved during the write', async () => {
    const files = new FakeFiles({ text: '{}', etag: ETAG });
    const racing = new FakeFiles({ text: null, etag: null }, new McpProjectFileChanged());

    const noEtag = await refusal(service({ files }).addProject('s1', { name: 'acme', server: COMMAND }));
    const stale = await refusal(service({ files }).addProject('s1', { name: 'acme', server: COMMAND, etag: null }));
    const raced = await refusal(
      service({ files: racing }).addProject('s1', { name: 'acme', server: COMMAND, etag: null }),
    );

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
    const files = new FakeFiles({ text: null, etag: null }, new Error('read-only file system'));

    const thrown = await service({ files })
      .addProject('s1', { name: 'acme', server: COMMAND, etag: null })
      .catch((error: unknown) => error);

    should(thrown).not.be.instanceOf(SessionMcpRefusal);
    should((thrown as Error).message).equal('read-only file system');
  });

  it('should refuse a server the project scope cannot hold, a folder it cannot reach and a file it will not rewrite', async () => {
    const signIn = await refusal(service().previewProject('s1', { name: 'acme', server: URL_SERVER }));
    const secret = await refusal(
      service().addProject('s1', { name: 'acme', server: { ...COMMAND, env: { KEY: secretRef('K') } }, etag: null }),
    );
    const codex = await refusal(
      service({ views: [ferret('s1', { harness: 'codex', folder: '/work/repo' })] }).previewProject('s1', {
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

    should([signIn.status, signIn.code]).deepEqual([400, 'mcp_server_refused']);
    should([secret.status, secret.code]).deepEqual([400, 'mcp_server_refused']);
    should([codex.status, codex.code]).deepEqual([409, 'mcp_project_unavailable']);
    should([unreadable.status, unreadable.code]).deepEqual([409, 'mcp_file_unreadable']);
  });
});

describe('adding to the login', () => {
  it('should preview the runtime, its profile, a replacement and every ferret that runs as it', async () => {
    const views = [ferret('s1'), ferret('s2'), ferret('s3', { runtime: 'someone-else' })];
    const subject = service({ views, login: login({ items: ['acme'] }).login });

    const preview = await subject.previewLogin('s1', { name: 'acme', server: URL_SERVER });

    should(preview).deepEqual({ scope: 'login', runtime: 'claude-work', profile: 'work', replaces: true, ferrets: 2 });
  });

  it('should write the item, then append it to the profile', async () => {
    const { login: target, calls } = login();
    const subject = service({ login: target });

    const added = await subject.addLogin('s1', {
      name: 'acme',
      server: { ...COMMAND, env: { TOKEN: secretRef('ACME') } },
    });

    should(added).deepEqual({ scope: 'login', name: 'acme', runtime: 'claude-work', profile: 'work' });
    should(calls.puts).deepEqual([
      { name: 'acme', item: { command: 'npx', args: ['acme'], env: { TOKEN: secretRef('ACME') } }, create: true },
    ]);
    should(calls.layered).deepEqual([{ profile: 'work', layers: ['instructions/base', 'mcp/acme'] }]);
  });

  it('should replace an item the profile already names without touching the profile', async () => {
    const { login: target, calls } = login({ items: ['acme'], profiles: [{ name: 'work', layers: ['mcp/acme'] }] });
    const subject = service({ login: target });

    await subject.addLogin('s1', { name: 'acme', server: URL_SERVER });
    await subject.addLogin('s1', { name: 'acme', server: { ...URL_SERVER, oauth: false } });

    should(calls.puts).deepEqual([
      { name: 'acme', item: { url: 'https://mcp.example.com', auth: 'oauth' }, create: false },
      { name: 'acme', item: { url: 'https://mcp.example.com' }, create: false },
    ]);
    should(calls.layered).be.empty();
  });

  it('should refuse a runtime the machine does not have, a missing profile and a raw secret', async () => {
    const stranger = service({ views: [ferret('s1', { runtime: 'claude-auto' })] });
    const orphan = service({ views: [ferret('s1', { runtime: 'orphan' })] });

    const unknown = await refusal(stranger.previewLogin('s1', { name: 'acme', server: COMMAND }));
    const noProfile = await refusal(orphan.addLogin('s1', { name: 'acme', server: COMMAND }));
    const raw = await refusal(
      stranger.addLogin('s1', { name: 'acme', server: { ...COMMAND, env: { KEY: 'sk-live-1' } } }),
    );

    should([unknown.status, unknown.code, unknown.message]).deepEqual([
      409,
      'mcp_runtime_unknown',
      'claude-auto is not a runtime on this machine, so there is no login to add the server to. Add it to This project instead.',
    ]);
    should([noProfile.status, noProfile.code, noProfile.message]).deepEqual([
      409,
      'mcp_runtime_unknown',
      'orphan launches with the profile gone, which this machine does not have.',
    ]);
    should([raw.status, raw.code]).deepEqual([400, 'mcp_server_refused']);
  });
});
