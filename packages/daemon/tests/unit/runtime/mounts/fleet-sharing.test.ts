/**
 * The sharing surface at the daemon's front door: the report, and the two changes that move an account
 * between a shared document and its own copy.
 *
 * Everything here goes through the real mount over a real temporary state home, because the parts worth
 * proving are the ones the pure domain cannot: that the report is parsed through the shared schema on
 * the way out, that an unlink derives its private copy from the shared document's *actual bytes*, and
 * that applying one writes exactly the two documents the reviewer was shown and nothing else.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../../src/adapters/filesystem/state-file-system.ts';
import { ProcfsSessionRootPinner } from '../../../../src/adapters/session/filesystem/index.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { createFoundationPaths } from '../../../../src/lib/paths.ts';
import { createDaemonFleetSubsystem, fleetRoutes } from '../../../../src/lib/runtime/mounts/fleet.ts';
import { resolveStateHome } from '../../../../src/lib/state-home.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED } from './support.ts';

const GENERATED_AT_MS = Date.parse('2027-02-02T09:00:00.000Z');
const CLAUDE_ID = '00000000-0000-4000-8000-0000000000d1';
const CODEX_ID = '00000000-0000-4000-8000-0000000000d2';
const SHARED_TEXT = '# Shared house instructions\n\nBe careful.\n';

const admin = { authorization: `Bearer ${CREDENTIALS.admin}` } as const;
const device = { authorization: 'Bearer paired-device' } as const;

const temporaryDirectories: string[] = [];
let minted = 1;

interface Fixture {
  readonly paths: ReturnType<typeof createFoundationPaths>;
  readonly dispatcher: ApiDispatcher;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'fy-fleet-sharing-'));
  temporaryDirectories.push(root);
  const userHome = join(root, 'user');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: join(root, 'fy-home'), homeDirectory: userHome }));
  const subsystem = createDaemonFleetSubsystem({
    paths,
    userHome,
    clock: { now: () => GENERATED_AT_MS },
    files: new StateFileSystem(paths),
    platform: 'linux',
    mintId: () => `sharing${String(minted++).padStart(15, '0')}`,
    mintUuid: () => `00000000-0000-4000-8000-8${String(minted++).padStart(11, '0')}`,
    mintApprovalCode: () => 'AAAA-BBBB',
    rootPinner: new ProcfsSessionRootPinner(),
  });
  const credentials = {
    ...CREDENTIALS,
    devices: { identify: (token: string) => (token === 'paired-device' ? 'device-1' : undefined) },
  };
  return { paths, dispatcher: new ApiDispatcher(new ApiRouter(fleetRoutes(subsystem)), credentials, GRANTED) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const CONFIG = `
shared:
  memory:
    default: ./CLAUDE.md
    terse: ./terse.md
  skills:
    default: ./skills
variants:
  default: {}
profiles:
  base:
    memory: ./CLAUDE.md
agents:
  - name: work
    kind: claude
    routes:
      default:
        id: ${CLAUDE_ID}
        wrapper: fy-claude-work
        home: claude-work
        defaultModel: opus
        models: [opus]
  - name: aux
    kind: codex
    routes:
      default:
        id: ${CODEX_ID}
        wrapper: fy-codex-aux
        home: codex-aux
        defaultModel: gpt
        models: [gpt]
`;

/** A host with a fleet, a declared shared document, and that document actually on disk. */
async function prepare(subject: Fixture, config = CONFIG): Promise<string> {
  const assets = join(subject.paths.fleet, 'assets');
  await mkdir(assets, { recursive: true });
  await writeFile(join(subject.paths.fleet, 'config.yaml'), config, 'utf8');
  await writeFile(join(assets, 'CLAUDE.md'), SHARED_TEXT, 'utf8');
  return assets;
}

const get = async (subject: Fixture, path: string, headers: Readonly<Record<string, string>> = admin) =>
  await subject.dispatcher.dispatch(request({ path, headers }));

const post = async (subject: Fixture, path: string, body: unknown, headers: Readonly<Record<string, string>> = admin) =>
  await subject.dispatcher.dispatch(
    request({
      method: 'POST',
      path,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

interface Proposal {
  readonly id: string;
  readonly summary: string;
  readonly preview: { readonly kind: string; readonly documents: { path: string; bytes: number }[] };
}

async function propose(subject: Fixture, mutation: unknown): Promise<Proposal> {
  const response = await post(subject, '/v1/fleet/proposals', { mutation });
  should([response.status, jsonBody(response)]).match([200, {}]);
  return jsonBody(response) as unknown as Proposal;
}

const refusal = async (subject: Fixture, mutation: unknown): Promise<string> => {
  const response = await post(subject, '/v1/fleet/proposals', { mutation });
  should(response.status).equal(409);
  return (jsonBody(response) as unknown as { error: string }).error;
};

describe('GET /v1/fleet/sharing', () => {
  it('should report every declared document and each account state', async () => {
    // Arrange
    const subject = await fixture();
    await prepare(subject);

    // Act
    const response = await get(subject, '/v1/fleet/sharing');

    // Assert — the report is derived from the configuration, so it needs no applied manifest at all.
    should(response.status).equal(200);
    should(jsonBody(response)).match({
      documents: [
        { field: 'memory', name: 'default', path: './CLAUDE.md', accounts: [CLAUDE_ID, CODEX_ID] },
        { field: 'memory', name: 'terse', path: './terse.md', accounts: [] },
        { field: 'skills', name: 'default', path: './skills', accounts: [] },
      ],
      accounts: [
        {
          accountId: CLAUDE_ID,
          wrapper: 'fy-claude-work',
          fields: { memory: { state: 'shared', name: 'default', referrers: 2 } },
          linkable: ['memory', 'skills', 'mcp'],
        },
        { accountId: CODEX_ID, fields: { memory: { state: 'shared', name: 'default' } } },
      ],
    });
  });

  it('should let a paired device read it, since reading discloses no host authority', async () => {
    // Arrange
    const subject = await fixture();
    await prepare(subject);

    // Act / Assert — the same rule every other fleet read follows: a device may look.
    should((await get(subject, '/v1/fleet/sharing', device)).status).equal(200);
  });

  it('should refuse to invent a report for a host with no fleet configuration', async () => {
    // Arrange
    const subject = await fixture();

    // Act
    const response = await get(subject, '/v1/fleet/sharing');

    // Assert — an empty report would read as "this fleet shares nothing", which is a different fact.
    should(response.status).equal(409);
    should(jsonBody(response)).match({ code: 'fleet_config_missing' });
  });
});

describe('linking an account to a shared document', () => {
  it('should say which document and which direction in the summary a person approves', async () => {
    // Arrange
    const subject = await fixture();
    await prepare(subject);

    // Act
    const proposal = await propose(subject, {
      kind: 'link-shared-asset',
      accountId: CLAUDE_ID,
      field: 'memory',
      name: 'terse',
    });

    // Assert — "change fy-claude-work" would not be enough for somebody deciding whether to approve a
    // switch of an account's instructions.
    should(proposal.summary).equal('link fy-claude-work memory to the shared "terse"');
  });

  it('should write only the configuration, carrying no asset document of its own', async () => {
    // Arrange
    const subject = await fixture();
    await prepare(subject);

    // Act
    const proposal = await propose(subject, {
      kind: 'link-shared-asset',
      accountId: CLAUDE_ID,
      field: 'memory',
      name: 'terse',
    });

    // Assert — a link changes which document is referenced and never the documents themselves.
    should(proposal.preview.documents.map(document => document.path)).deepEqual([
      join(subject.paths.fleet, 'config.yaml'),
    ]);
  });

  it('should plan a copy of the linked document into the account home', async () => {
    // Arrange
    const subject = await fixture();
    await prepare(subject);
    await writeFile(join(subject.paths.fleet, 'assets', 'terse.md'), 'Terse.\n', 'utf8');

    // Act
    const response = await post(subject, '/v1/fleet/proposals', {
      mutation: { kind: 'link-shared-asset', accountId: CLAUDE_ID, field: 'memory', name: 'terse' },
    });

    // Assert — this is what "the account reads the shared document" means at plan time: apply copies
    // that source into this account's home as the harness's own instructions file.
    should(response.status).equal(200);
    const plan = (
      jsonBody(response) as unknown as {
        preview: { plan: { operations: { kind: string; source?: string; path: string }[] } };
      }
    ).preview.plan;
    should(plan.operations).containEql({
      kind: 'copy',
      source: join(subject.paths.fleet, 'assets', 'terse.md'),
      path: join(subject.paths.fleet, 'homes', 'claude-work', 'CLAUDE.md'),
    });
  });

  it('should refuse a name this fleet does not declare, as an actionable refusal', async () => {
    // Arrange
    const subject = await fixture();
    await prepare(subject);

    // Act / Assert
    should(
      await refusal(subject, { kind: 'link-shared-asset', accountId: CLAUDE_ID, field: 'memory', name: 'nope' }),
    ).match(/no shared "memory" document named "nope"/u);
  });
});

describe('giving an account its own copy', () => {
  const unlink = { kind: 'unlink-shared-asset', accountId: CLAUDE_ID, field: 'memory' } as const;

  it('should derive the private copy from the shared document as it is now', async () => {
    // Arrange
    const subject = await fixture();
    await prepare(subject);

    // Act
    const proposal = await propose(subject, unlink);

    // Assert — the copy is a real write the reviewer sees, at a path derived from the wrapper, with the
    // shared document's exact byte length. Nothing was supplied by the caller.
    should(proposal.summary).equal('give fy-claude-work its own memory');
    should(proposal.preview.documents).deepEqual([
      { path: join(subject.paths.fleet, 'config.yaml'), bytes: proposal.preview.documents[0]?.bytes ?? 0 },
      {
        path: join(subject.paths.fleet, 'assets', 'accounts', 'fy-claude-work', 'CLAUDE.md'),
        bytes: new TextEncoder().encode(SHARED_TEXT).length,
      },
    ]);
  });

  it('should write the copy and point the account at it when applied', async () => {
    // Arrange
    const subject = await fixture();
    await prepare(subject);
    const proposal = await propose(subject, unlink);

    // Act
    const response = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, undefined);

    // Assert — the account now has its own copy holding the shared text, the shared document is
    // untouched, and the other account is still on it.
    should([response.status, jsonBody(response)]).match([200, { outcome: 'committed' }]);
    const copy = join(subject.paths.fleet, 'assets', 'accounts', 'fy-claude-work', 'CLAUDE.md');
    should(await readFile(copy, 'utf8')).equal(SHARED_TEXT);
    should(await readFile(join(subject.paths.fleet, 'assets', 'CLAUDE.md'), 'utf8')).equal(SHARED_TEXT);
    const sharing = jsonBody(await get(subject, '/v1/fleet/sharing')) as unknown as {
      accounts: { accountId: string; fields: { memory: { state: string; path?: string } } }[];
    };
    should(sharing.accounts.find(account => account.accountId === CLAUDE_ID)?.fields.memory).match({
      state: 'local',
      path: 'accounts/fy-claude-work/CLAUDE.md',
    });
    should(sharing.accounts.find(account => account.accountId === CODEX_ID)?.fields.memory).match({
      state: 'shared',
      name: 'default',
    });
  });

  it('should copy the shared document into the account home on the same apply', async () => {
    // Arrange
    const subject = await fixture();
    await prepare(subject);
    const proposal = await propose(subject, unlink);

    // Act
    should((await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, undefined)).status).equal(200);

    // Assert — "materializes a private copy rather than leaving the account with nothing": the home has
    // the instructions, from the account's own document rather than the shared one.
    should(await readFile(join(subject.paths.fleet, 'homes', 'claude-work', 'CLAUDE.md'), 'utf8')).equal(SHARED_TEXT);
  });

  it('should refuse rather than overwrite a document already at the destination', async () => {
    // Arrange
    const subject = await fixture();
    const assets = await prepare(subject);
    await mkdir(join(assets, 'accounts', 'fy-claude-work'), { recursive: true });
    await writeFile(join(assets, 'accounts', 'fy-claude-work', 'CLAUDE.md'), 'work in progress\n', 'utf8');

    // Act
    const message = await refusal(subject, unlink);

    // Assert — it is the account's own earlier copy or somebody's draft, and replacing it with the
    // shared text is not what "give this account its own copy" asked for.
    should(message).match(/already has an asset at "accounts\/fy-claude-work\/CLAUDE.md"/u);
    should(await readFile(join(assets, 'accounts', 'fy-claude-work', 'CLAUDE.md'), 'utf8')).equal('work in progress\n');
  });

  it('should refuse when the shared document it would copy is not on disk', async () => {
    // Arrange — declared and referenced, but never created.
    const subject = await fixture();
    await mkdir(subject.paths.fleet, { recursive: true });
    await writeFile(join(subject.paths.fleet, 'config.yaml'), CONFIG, 'utf8');

    // Act / Assert — the refusal names the asset rather than reporting a daemon defect.
    should(await refusal(subject, unlink)).match(/no asset at "CLAUDE\.md"/u);
  });

  it('should refuse a directory asset with the manual remedy', async () => {
    // Arrange
    const subject = await fixture();
    await prepare(
      subject,
      CONFIG.replace('  base:\n    memory: ./CLAUDE.md', '  base:\n    memory: ./CLAUDE.md\n    skills: ./skills'),
    );

    // Act / Assert
    should(await refusal(subject, { kind: 'unlink-shared-asset', accountId: CLAUDE_ID, field: 'skills' })).match(
      /names a directory, and a private copy of a directory is not something the reviewed asset editor can write/u,
    );
  });

  it('should refuse a stale change once the shared document has been edited', async () => {
    // Arrange
    const subject = await fixture();
    const assets = await prepare(subject);
    const proposal = await propose(subject, unlink);
    await writeFile(join(assets, 'CLAUDE.md'), 'somebody edited the shared document\n', 'utf8');

    // Act
    const response = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, undefined);

    // Assert — the copy was composed against text that no longer exists, so writing it would silently
    // give the account an older document than the one it is leaving.
    should(response.status).equal(409);
    should(jsonBody(response)).match({ code: 'fleet_proposal_stale' });
  });
});
