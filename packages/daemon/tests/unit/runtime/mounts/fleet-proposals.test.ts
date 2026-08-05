import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import { CREDENTIALS } from './support.ts';

const GENERATED_AT_MS = Date.parse('2027-01-15T08:00:00.000Z');
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const temporaryDirectories: string[] = [];

const admin = { authorization: `Bearer ${CREDENTIALS.admin}` } as const;
const warden = { authorization: `Bearer ${CREDENTIALS.warden}` } as const;
const device = { authorization: 'Bearer paired-device' } as const;

interface Fixture {
  readonly paths: ReturnType<typeof createFoundationPaths>;
  readonly dispatcher: ApiDispatcher;
  readonly clock: { value: number };
}

let minted = 1;

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'fy-fleet-proposal-'));
  temporaryDirectories.push(root);
  const userHome = join(root, 'user');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: join(root, 'fy-home'), homeDirectory: userHome }));
  const clock = { value: GENERATED_AT_MS };
  const subsystem = createDaemonFleetSubsystem({
    paths,
    userHome,
    clock: { now: () => clock.value },
    files: new StateFileSystem(paths),
    platform: 'linux',
    mintId: () => `proposal${String(minted++).padStart(14, '0')}`,
    // Deliberately in a range the fixture configuration never uses, so a minted account can never
    // collide with a declared one and make a create look like a duplicate.
    mintUuid: () => `00000000-0000-4000-8000-9${String(minted++).padStart(11, '0')}`,
    mintApprovalCode: () => 'AAAA-BBBB',
    rootPinner: new ProcfsSessionRootPinner(),
  });
  const credentials = {
    ...CREDENTIALS,
    devices: { identify: (token: string) => (token === 'paired-device' ? 'device-1' : undefined) },
  };
  return { paths, clock, dispatcher: new ApiDispatcher(new ApiRouter(fleetRoutes(subsystem)), credentials) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const CONFIG = `
variants:
  default: {}
  auto:
    mode: auto
agents:
  - name: work
    kind: claude
    routes:
      default:
        id: ${ACCOUNT_ID}
        wrapper: fy-claude-work
        home: claude-work
        defaultModel: opus
        models: [opus]
`;

async function writeConfig(subject: Fixture, content = CONFIG): Promise<void> {
  await mkdir(subject.paths.fleet, { recursive: true });
  await writeFile(join(subject.paths.fleet, 'config.yaml'), content, 'utf8');
}

const post = async (subject: Fixture, path: string, headers: object, body?: unknown) =>
  await subject.dispatcher.dispatch(
    request({
      method: 'POST',
      path,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const get = async (subject: Fixture, path: string, headers: Readonly<Record<string, string>>) =>
  await subject.dispatcher.dispatch(request({ path, headers }));

const CREATE = {
  mutation: {
    kind: 'create-account',
    harness: 'claude',
    name: 'atomi',
    models: ['opus'],
    defaultModel: 'opus',
  },
} as const;

/** Compose a change and return the proposal the daemon is holding. */
async function propose(subject: Fixture, body: unknown = CREATE, headers: Readonly<Record<string, string>> = admin) {
  const response = await post(subject, '/v1/fleet/proposals', headers, body);
  // The body is in the message so a refusal says what it refused rather than only a status.
  should([response.status, jsonBody(response)]).match([200, {}]);
  return jsonBody(response) as {
    id: string;
    revision: string;
    summary: string;
    state: string;
    preview: {
      kind: string;
      documents: { path: string; bytes: number }[];
      plan?: { manifest: { generatedAt: string } };
    };
    approval: { outstanding: boolean } | undefined;
  };
}

describe('composing a fleet change', () => {
  it('should write nothing at all', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const before = await readFile(join(subject.paths.fleet, 'config.yaml'), 'utf8');

    // Act
    const proposal = await propose(subject);

    // Assert — a preview a person has not agreed to is not a change to their host.
    should(proposal.state).equal('pending');
    should(await readFile(join(subject.paths.fleet, 'config.yaml'), 'utf8')).equal(before);
    should(await Bun.file(subject.paths.fleetManifest).exists()).be.false();
  });

  it('should name every write, including the configuration and the assets', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const proposal = await propose(subject, {
      ...CREATE,
      assetEdits: [{ path: 'CLAUDE.md', content: 'be brief\n' }],
    });

    // Assert — reviewing every write before it happens has to include the ones that are not plan
    // operations, or the review is of half the change.
    should(proposal.preview.documents.map(document => document.path.split('/').at(-1))).deepEqual([
      'config.yaml',
      'CLAUDE.md',
    ]);
    should(proposal.preview.documents.at(-1)?.bytes).equal(9);
  });

  it('should let a paired device compose one, because composing changes nothing', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const proposal = await propose(subject, CREATE, device);

    // Assert
    should(proposal.state).equal('pending');
  });

  it('should refuse a warden outright', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const actual = await post(subject, '/v1/fleet/proposals', warden, CREATE);

    // Assert
    should(actual.status).equal(403);
  });

  it('should refuse an anonymous caller outright', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const actual = await post(subject, '/v1/fleet/proposals', {}, CREATE);

    // Assert
    should(actual.status).equal(401);
  });

  it('should refuse an asset path that escapes the asset tree', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const actual = await post(subject, '/v1/fleet/proposals', admin, {
      ...CREATE,
      assetEdits: [{ path: '../../escape.md', content: 'no' }],
    });

    // Assert
    should(actual.status).equal(409);
    should(jsonBody(actual)).match({ code: 'fleet_asset_refused' });
  });

  it('should refuse an asset path that passes through a link', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    await mkdir(join(subject.paths.fleet, 'assets'), { recursive: true });
    await symlink(join(subject.paths.home, 'elsewhere'), join(subject.paths.fleet, 'assets', 'linked'));

    // Act
    const actual = await post(subject, '/v1/fleet/proposals', admin, {
      ...CREATE,
      assetEdits: [{ path: 'linked/CLAUDE.md', content: 'no' }],
    });

    // Assert
    should(actual.status).equal(409);
    should(jsonBody(actual)).match({ code: 'fleet_asset_refused' });
  });
});

describe('authorizing a fleet change', () => {
  it('should mint a code for the host and never disclose it in a read', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);

    // Act
    const minted = await post(subject, `/v1/fleet/proposals/${proposal.id}/authorize`, admin);
    const read = await get(subject, `/v1/fleet/proposals/${proposal.id}`, admin);

    // Assert
    const mint = jsonBody(minted) as { code: string; summary: string; mutation: string };
    should(minted.status).equal(200);
    should(mint.code).match(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/u);
    should(mint.mutation).equal('create-account');
    should(mint.summary).equal('add claude-atomi');
    should(JSON.stringify(jsonBody(read))).not.match(new RegExp(mint.code, 'u'));
    should(jsonBody(read)).match({ approval: { outstanding: true } });
  });

  it('should refuse a paired device, because a device cannot authorise itself', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);

    // Act
    const actual = await post(subject, `/v1/fleet/proposals/${proposal.id}/authorize`, device);

    // Assert
    should(actual.status).equal(403);
  });

  it('should report an unknown change as unknown and an expired one as expired', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);

    // Act
    const unknown = await post(subject, '/v1/fleet/proposals/fy_fprop_never0000000000/authorize', admin);
    subject.clock.value += 16 * 60 * 1000;
    const expired = await post(subject, `/v1/fleet/proposals/${proposal.id}/authorize`, admin);

    // Assert — a timed-out change must not send a person hunting for a typo in a correct id.
    should(jsonBody(unknown)).match({ code: 'fleet_proposal_unknown' });
    should(jsonBody(expired)).match({ code: 'fleet_proposal_expired' });
  });
});

describe('applying a fleet change', () => {
  it('should materialise the account and publish the manifest for an admin', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);

    // Act
    const applied = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);

    // Assert
    should(applied.status).equal(200);
    should(jsonBody(applied)).match({ outcome: 'committed' });
    should(await readFile(join(subject.paths.fleet, 'config.yaml'), 'utf8')).match(/claude-atomi/u);
    should(await Bun.file(join(subject.paths.fleet, 'bin', 'claude-atomi')).exists()).be.true();
  });

  it('should apply exactly the artifact that was reviewed, not one rebuilt at apply time', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);
    const reviewed = proposal.preview.plan?.manifest.generatedAt;

    // Act — the clock moves between the review and the apply.
    subject.clock.value += 60_000;
    await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);

    // Assert — a rebuilt plan would carry the later timestamp, so what landed would differ from
    // what was read.
    const manifest = JSON.parse(await readFile(subject.paths.fleetManifest, 'utf8')) as { generatedAt: string };
    should(reviewed).be.a.String();
    should(manifest.generatedAt).equal(reviewed);
  });

  it('should refuse a device with no approval, and accept it with the minted one', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);

    // Act
    const bare = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device);
    const mint = jsonBody(await post(subject, `/v1/fleet/proposals/${proposal.id}/authorize`, admin)) as {
      code: string;
    };
    const approved = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, {
      approvalCode: mint.code.toLowerCase(),
    });

    // Assert — pairing is not provisioning; an approval the host minted for this one change is.
    should(jsonBody(bare)).match({ code: 'fleet_proposal_unauthorized' });
    should(approved.status).equal(200);
    should(jsonBody(approved)).match({ outcome: 'committed' });
  });

  it('should refuse a wrong code and stop accepting any once the budget is spent', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);
    const mint = jsonBody(await post(subject, `/v1/fleet/proposals/${proposal.id}/authorize`, admin)) as {
      code: string;
    };

    // Act
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, { approvalCode: 'ZZZZ-ZZZZ' });
    }
    const spent = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, { approvalCode: mint.code });

    // Assert
    should(jsonBody(spent)).match({ code: 'fleet_proposal_refused' });
    should(await Bun.file(subject.paths.fleetManifest).exists()).be.false();
  });

  it('should let exactly one of two applies arriving together consume the change', async () => {
    // Arrange — the check and the consume happen in one synchronous step for this reason: two
    // applies in flight must not both pass the check and both run against the host.
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);

    // Act
    const [first, second] = await Promise.all([
      post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin),
      post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin),
    ]);

    // Assert — one committed, one told it already happened; never two of either.
    const outcomes = [jsonBody(first), jsonBody(second)] as { outcome?: string; code?: string }[];
    should(outcomes.filter(body => body.outcome === 'committed')).have.length(1);
    should(outcomes.filter(body => body.code === 'fleet_proposal_consumed')).have.length(1);
  });

  it('should not let repeated empty codes spend the approval budget', async () => {
    // Arrange — offering nothing is not a guess. If it cost a try, a client with no code at all
    // could burn the budget belonging to the person who has one.
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);
    const mint = jsonBody(await post(subject, `/v1/fleet/proposals/${proposal.id}/authorize`, admin)) as {
      code: string;
      maxAttempts: number;
    };

    // Act — more empty attempts than the budget would ever allow, then the real code.
    for (let attempt = 0; attempt < mint.maxAttempts + 3; attempt += 1) {
      const bare = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device);
      should(jsonBody(bare)).match({ code: 'fleet_proposal_unauthorized' });
    }
    const approved = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, {
      approvalCode: mint.code,
    });

    // Assert — the budget was never touched, so the person's code still works.
    should(jsonBody(approved)).match({ outcome: 'committed' });
  });

  it('should refuse to apply the same change twice', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);
    await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);

    // Act
    const again = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);

    // Assert
    should(jsonBody(again)).match({ code: 'fleet_proposal_consumed' });
  });

  it('should refuse a change whose configuration moved under it, and keep it applicable', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);

    // Act — somebody edits the host between the review and the apply.
    await writeConfig(subject, `${CONFIG}\n# edited by hand\n`);
    const stale = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);

    // Assert — nothing landed, so the change is still there to be reviewed again.
    should(jsonBody(stale)).match({ code: 'fleet_proposal_stale' });
    should(await Bun.file(subject.paths.fleetManifest).exists()).be.false();
    should(
      (jsonBody(await get(subject, `/v1/fleet/proposals/${proposal.id}`, admin)) as { state: string }).state,
    ).equal('pending');
  });

  it('should keep a change consumed when materialization fails in a way nobody classified', async () => {
    // Arrange — the account names instructions that do not exist. The preview does not read asset
    // sources, so composing succeeds; the apply's preflight does, and throws a plain filesystem
    // error rather than a classified rollback report.
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject, {
      mutation: { ...CREATE.mutation, layer: { memory: './nothing-is-here.md' } },
    });

    // Act
    const failed = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);
    const retry = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);

    // Assert — an unclassified failure says nothing about what the host now is, so the change is
    // NOT handed back as still applicable. Reopening it would invite a second apply on top of a
    // state nobody has established.
    should(jsonBody(failed)).match({ code: 'fleet_apply_refused' });
    should(jsonBody(retry)).match({ code: 'fleet_proposal_consumed' });
  });

  it('should refuse a change whose edited asset moved under it', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    await mkdir(join(subject.paths.fleet, 'assets'), { recursive: true });
    await writeFile(join(subject.paths.fleet, 'assets', 'CLAUDE.md'), 'the original\n');
    const proposal = await propose(subject, { ...CREATE, assetEdits: [{ path: 'CLAUDE.md', content: 'mine\n' }] });

    // Act — somebody else edits the same instructions in the meantime.
    await writeFile(join(subject.paths.fleet, 'assets', 'CLAUDE.md'), 'theirs\n');
    const stale = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);

    // Assert — their text survives rather than being replaced by text written against the old one.
    should(jsonBody(stale)).match({ code: 'fleet_proposal_stale' });
    should(await readFile(join(subject.paths.fleet, 'assets', 'CLAUDE.md'), 'utf8')).equal('theirs\n');
  });
});

describe('applying a fleet change that fails', () => {
  it('should roll the configuration back rather than leave a half-materialised account', async () => {
    // Arrange — a regular file occupies the home the new account needs, so the directory operation
    // fails at the mutation boundary while surviving preflight.
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);
    await mkdir(join(subject.paths.fleet, 'homes'), { recursive: true });
    await writeFile(join(subject.paths.fleet, 'homes', 'claude-atomi'), 'in the way\n');

    // Act
    const applied = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);

    // Assert — the outcome is a body, not a bare refusal, and the host still declares what it did.
    should(applied.status).equal(200);
    should(jsonBody(applied)).match({ outcome: 'rolled-back' });
    should(await readFile(join(subject.paths.fleet, 'config.yaml'), 'utf8')).not.match(/claude-atomi/u);
    should(await Bun.file(subject.paths.fleetManifest).exists()).be.false();
    should(await Bun.file(join(subject.paths.fleet, 'bin', 'claude-atomi')).exists()).be.false();
  });

  it('should refuse a change composed against a configuration the host cannot parse', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject, 'agents: [this is not a fleet]\n');

    // Act
    const actual = await post(subject, '/v1/fleet/proposals', admin, CREATE);

    // Assert — damaged is not empty, and it is not somewhere to add an account.
    should(jsonBody(actual)).match({ code: 'fleet_config_invalid' });
  });

  it('should compose against a fleet that positively declares no accounts', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject, 'variants:\n  default: {}\nagents: []\n');

    // Act
    const proposal = await propose(subject);

    // Assert — an empty fleet is a fleet; it is only a missing one that cannot be added to.
    should(proposal.summary).equal('add claude-atomi');
  });
});

describe('replaying an approval', () => {
  it('should refuse a code that has expired', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);
    const mint = jsonBody(await post(subject, `/v1/fleet/proposals/${proposal.id}/authorize`, admin)) as {
      code: string;
      ttlSeconds: number;
    };

    // Act — at the instant it expires, not a millisecond past it.
    subject.clock.value += mint.ttlSeconds * 1000;
    const actual = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, {
      approvalCode: mint.code,
    });

    // Assert
    should(jsonBody(actual)).match({ code: 'fleet_proposal_expired' });
  });

  it('should refuse a code replayed after the change it approved was applied', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);
    const mint = jsonBody(await post(subject, `/v1/fleet/proposals/${proposal.id}/authorize`, admin)) as {
      code: string;
    };
    await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, { approvalCode: mint.code });

    // Act
    const replayed = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, {
      approvalCode: mint.code,
    });

    // Assert — single use means the second attempt is told the change already happened.
    should(jsonBody(replayed)).match({ code: 'fleet_proposal_consumed' });
  });
});

describe('preparing a host that has no fleet', () => {
  it('should scaffold from the reviewed value and keep an existing file', async () => {
    // Arrange — no configuration at all.
    const subject = await fixture();
    await mkdir(join(subject.paths.fleet, 'assets'), { recursive: true });
    await writeFile(join(subject.paths.fleet, 'assets', 'CLAUDE.md'), 'mine already\n');
    const proposal = await propose(subject, { mutation: { kind: 'initialize' } });

    // Act
    const applied = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);

    // Assert — create-if-absent is the kernel's decision, so a file somebody wrote is never lost.
    // Preparing a host is its own outcome: reporting it as an apply that published zero accounts
    // would tell a person their fleet is empty rather than that it is now ready.
    const body = jsonBody(applied) as { outcome: string; kept: string[]; created: string[]; pathEntry: string };
    should(body.outcome).equal('initialized');
    should(body.kept).containEql(join(subject.paths.fleet, 'assets', 'CLAUDE.md'));
    should(body.created).containEql(join(subject.paths.fleet, 'config.yaml'));
    should(body.pathEntry).be.a.String();
    should(await readFile(join(subject.paths.fleet, 'assets', 'CLAUDE.md'), 'utf8')).equal('mine already\n');
    should(await Bun.file(join(subject.paths.fleet, 'config.yaml')).exists()).be.true();
  });

  it('should name exactly what it kept, what it created and where it stopped', async () => {
    // Arrange — one starter asset already exists, so it is KEPT; earlier ones land, so they are
    // CREATED; and a directory occupies the name of a later one, so preparation stops there. There
    // is no undo for any of it, so the honest answer is all three facts and where it got to.
    // (The configuration itself must stay absent, or this host would not be one to prepare.)
    const subject = await fixture();
    await mkdir(join(subject.paths.fleet, 'assets'), { recursive: true });
    await writeFile(join(subject.paths.fleet, 'assets', 'README.md'), '# mine already\n');
    await mkdir(join(subject.paths.fleet, 'assets', 'CLAUDE.md'), { recursive: true });
    const proposal = await propose(subject, { mutation: { kind: 'initialize' } });

    // Act
    const applied = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);

    // Assert — its own outcome, with exact evidence; never an apply that "published 0 accounts".
    const body = jsonBody(applied) as Record<string, unknown> & {
      outcome: string;
      failedPath: string;
      reason: string;
      created: string[];
      kept: string[];
      directories: string[];
    };
    should(applied.status).equal(200);
    const failed = join(subject.paths.fleet, 'assets', 'CLAUDE.md');
    should(body.outcome).equal('initialization-partial');
    should(body.failedPath).equal(failed);
    should(body.reason).equal(`${failed} exists but is not a file, so the fleet cannot be prepared here`);
    should(body.kept).deepEqual([join(subject.paths.fleet, 'assets', 'README.md')]);
    should(body.created).deepEqual([join(subject.paths.fleet, 'config.yaml')]);
    // The full ordered list the scaffold declares, so a directory silently dropped would show up.
    should(body.directories).deepEqual([
      subject.paths.fleet,
      join(subject.paths.fleet, 'bin'),
      join(subject.paths.fleet, 'homes'),
      join(subject.paths.fleet, 'assets'),
      join(subject.paths.fleet, 'assets', 'templates'),
      join(subject.paths.fleet, 'assets', 'templates', 'claude'),
      join(subject.paths.fleet, 'assets', 'templates', 'codex'),
    ]);
    // Nothing was published, so nothing pretends otherwise.
    should(Object.hasOwn(body, 'manifestPath')).be.false();
    should(Object.hasOwn(body, 'pathEntry')).be.false();
    // And the file that was already there is exactly as its owner left it.
    should(await readFile(join(subject.paths.fleet, 'assets', 'README.md'), 'utf8')).equal('# mine already\n');
  });

  it('should refuse to prepare a host that already has a fleet', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const actual = await post(subject, '/v1/fleet/proposals', admin, { mutation: { kind: 'initialize' } });

    // Assert
    should(jsonBody(actual)).match({ code: 'fleet_proposal_refused' });
  });

  it('should refuse to carry asset edits, because that would be two commit boundaries', async () => {
    // Arrange
    const subject = await fixture();

    // Act
    const actual = await post(subject, '/v1/fleet/proposals', admin, {
      mutation: { kind: 'initialize' },
      assetEdits: [{ path: 'CLAUDE.md', content: 'hello' }],
    });

    // Assert
    should(jsonBody(actual)).match({ code: 'fleet_proposal_refused' });
  });
});

describe('who may reach each new fleet route', () => {
  const endpoints = [
    ['GET', '/v1/fleet/permissions'],
    ['GET', '/v1/fleet/assets'],
    ['GET', '/v1/fleet/assets/CLAUDE.md'],
    ['POST', '/v1/fleet/proposals'],
    ['GET', '/v1/fleet/proposals/fy_fprop_never0000000000'],
    ['POST', '/v1/fleet/proposals/fy_fprop_never0000000000/authorize'],
    ['POST', '/v1/fleet/proposals/fy_fprop_never0000000000/apply'],
  ] as const;

  it.each(endpoints)('should refuse an anonymous caller on %s %s', async (method, path) => {
    // Arrange
    const subject = await fixture();

    // Act
    const actual = await subject.dispatcher.dispatch(request({ method, path }));

    // Assert
    should(actual.status).equal(401);
  });

  it.each(endpoints)('should refuse a warden on %s %s', async (method, path) => {
    // Arrange
    const subject = await fixture();

    // Act
    const actual = await subject.dispatcher.dispatch(request({ method, path, headers: warden }));

    // Assert
    should(actual.status).equal(403);
  });

  it('should refuse a paired device only where the host itself must decide', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const reads = await Promise.all([
      get(subject, '/v1/fleet/permissions', device),
      get(subject, '/v1/fleet/assets', device),
    ]);
    const mint = await post(subject, '/v1/fleet/proposals/fy_fprop_never0000000000/authorize', device);

    // Assert — a device may look and may compose; only minting an approval is the host's alone.
    should(reads.map(response => response.status)).deepEqual([200, 200]);
    should(mint.status).equal(403);
  });

  it.each(endpoints)('should answer %s %s with no-store', async (method, path) => {
    // Arrange — every one of these discloses host paths, a proposal, or an approval's existence.
    const subject = await fixture();

    // Act
    const actual = await subject.dispatcher.dispatch(request({ method, path, headers: admin }));

    // Assert
    should(actual.headers.get('cache-control')).match(/no-store/u);
  });
});

describe('reading what a credential may do', () => {
  it('should tell an admin it may apply directly and a device that it needs an approval', async () => {
    // Arrange
    const subject = await fixture();

    // Act
    const asAdmin = jsonBody(await get(subject, '/v1/fleet/permissions', admin));
    const asDevice = jsonBody(await get(subject, '/v1/fleet/permissions', device));

    // Assert — said before a click, so the surface never offers a control that ends in a refusal.
    should(asAdmin).match({ mayInspect: true, mayPropose: true, mayApplyDirectly: true, mayApplyWithApproval: false });
    should(asDevice).match({ mayInspect: true, mayPropose: true, mayApplyDirectly: false, mayApplyWithApproval: true });
  });

  it('should refuse to apply for a credential class it does not recognise', async () => {
    // Arrange — the same rule as the permissions read, on the path that actually changes the host:
    // an unfamiliar class must not fall through to the host's own no-approval-needed branch.
    const subject = await fixture();
    const mounted = createDaemonFleetSubsystem({
      paths: subject.paths,
      userHome: join(subject.paths.home, 'user'),
      clock: { now: () => GENERATED_AT_MS },
      files: new StateFileSystem(subject.paths),
      platform: 'linux',
      mintId: () => 'proposal00000000000001',
      mintUuid: () => '00000000-0000-4000-8000-000000000002',
      mintApprovalCode: () => 'AAAA-BBBB',
      rootPinner: new ProcfsSessionRootPinner(),
    });

    // Act
    const act = async (): Promise<unknown> => await mounted.applyProposal('fy_fprop_never0000000000', {}, undefined);

    // Assert
    await should(act()).be.rejectedWith(/may not apply a fleet change/u);
  });

  it('should grant nothing to a credential class it does not recognise', async () => {
    // Arrange — the permissions read is a courtesy, and a courtesy must not invent authority out of
    // missing evidence. Deriving from `not a device` would have handed direct apply to an unknown.
    const subject = await fixture();
    const mounted = createDaemonFleetSubsystem({
      paths: subject.paths,
      userHome: join(subject.paths.home, 'user'),
      clock: { now: () => GENERATED_AT_MS },
      files: new StateFileSystem(subject.paths),
      platform: 'linux',
      mintId: () => 'proposal00000000000000',
      mintUuid: () => '00000000-0000-4000-8000-000000000001',
      mintApprovalCode: () => 'AAAA-BBBB',
      rootPinner: new ProcfsSessionRootPinner(),
    });

    // Act
    const actual = mounted.permissions(undefined);

    // Assert
    should(actual).match({
      mayInspect: false,
      mayPropose: false,
      mayApplyDirectly: false,
      mayApplyWithApproval: false,
    });
  });
});

describe('answering only what the shared contract describes', () => {
  it('should refuse to publish a roster that breaks the invariants the configuration enforces', async () => {
    // Arrange — a manifest on disk claiming an available account with a defaultModel it does not
    // serve. The configuration schema would never have produced this; a client comparing a proposed
    // roster against it would render an account that cannot launch.
    const subject = await fixture();
    await mkdir(subject.paths.fleet, { recursive: true });
    await writeFile(
      subject.paths.fleetManifest,
      JSON.stringify({
        version: 1,
        generatedAt: '2027-01-15T08:00:00.000Z',
        accounts: [
          {
            id: ACCOUNT_ID,
            kind: 'claude',
            mode: 'interactive',
            wrapper: '/bin/fy-claude-work',
            home: '/homes/claude-work',
            displayName: 'Work',
            defaultModel: 'a-model-it-does-not-serve',
            models: [{ id: 'opus', available: true }],
            available: true,
            unavailableReason: null,
          },
        ],
      }),
    );

    // Act
    const actual = await get(subject, '/v1/fleet/accounts', admin);

    // Assert — refused as damaged rather than handed to a client as a roster it would render and
    // nobody could launch. The domain manifest schema catches this one first, which is the right
    // place: it is the same rule the configuration enforces, applied to the published record.
    should(actual.status).equal(409);
    should(jsonBody(actual)).match({ code: 'fleet_manifest_invalid' });
  });

  it('should refuse to publish a roster whose accounts are not distinguishable', async () => {
    // Arrange — two accounts sharing one wrapper. Identity is what every consumer joins on, so a
    // roster that published it twice would make them indistinguishable exactly where it matters.
    const subject = await fixture();
    const account = {
      kind: 'claude',
      mode: 'interactive',
      wrapper: '/bin/fy-claude-work',
      displayName: 'Work',
      defaultModel: 'opus',
      models: [{ id: 'opus', available: true }],
      available: true,
      unavailableReason: null,
    };
    await mkdir(subject.paths.fleet, { recursive: true });
    await writeFile(
      subject.paths.fleetManifest,
      JSON.stringify({
        version: 1,
        generatedAt: '2027-01-15T08:00:00.000Z',
        accounts: [
          { ...account, id: ACCOUNT_ID, home: '/homes/one' },
          { ...account, id: '00000000-0000-4000-8000-000000000002', home: '/homes/two' },
        ],
      }),
    );

    // Act
    const actual = await get(subject, '/v1/fleet/accounts', admin);

    // Assert — whichever layer catches it, no client is handed the ambiguous roster.
    should(actual.status).be.aboveOrEqual(400);
  });

  it('should publish a well-formed roster through the shared manifest contract', async () => {
    // Arrange
    const subject = await fixture();
    await mkdir(subject.paths.fleet, { recursive: true });
    await writeFile(
      subject.paths.fleetManifest,
      JSON.stringify({
        version: 1,
        generatedAt: '2027-01-15T08:00:00.000Z',
        accounts: [
          {
            id: ACCOUNT_ID,
            kind: 'claude',
            mode: 'interactive',
            wrapper: '/bin/fy-claude-work',
            home: '/homes/claude-work',
            displayName: 'Work',
            defaultModel: 'opus',
            models: [{ id: 'opus', available: true }],
            available: true,
            unavailableReason: null,
          },
        ],
      }),
    );

    // Act
    const actual = await get(subject, '/v1/fleet/accounts', admin);

    // Assert — models travel, because comparing a proposed roster needs what each account serves.
    should(actual.status).equal(200);
    should(jsonBody(actual)).match({ accounts: [{ id: ACCOUNT_ID, models: [{ id: 'opus', available: true }] }] });
  });
});

describe('reading fleet assets', () => {
  it('should list what it can edit and describe honestly what it cannot', async () => {
    // Arrange
    const subject = await fixture();
    const assets = join(subject.paths.fleet, 'assets');
    await mkdir(join(assets, 'skills'), { recursive: true });
    await writeFile(join(assets, 'CLAUDE.md'), 'be brief\n');
    await writeFile(join(assets, 'skills', 'binary.md'), new Uint8Array([0xff, 0xfe, 0x00]));
    await symlink(join(subject.paths.home, 'elsewhere'), join(assets, 'linked.md'));

    // Act
    const actual = jsonBody(await get(subject, '/v1/fleet/assets', admin)) as {
      complete: boolean;
      files: { path: string; readable: boolean; reason?: string }[];
    };

    // Assert — an entry it will not touch is still listed, or a person concludes it is missing.
    should(actual.complete).be.true();
    should(actual.files.find(file => file.path === 'CLAUDE.md')).match({ readable: true });
    should(actual.files.find(file => file.path === 'linked.md')).match({ readable: false, reason: /link/u });
    should(actual.files.find(file => file.path === 'skills/binary.md')).match({ readable: false });
  });

  it('should return one asset as text and refuse one it cannot serve', async () => {
    // Arrange
    const subject = await fixture();
    const assets = join(subject.paths.fleet, 'assets');
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, 'CLAUDE.md'), 'be brief\n');

    // Act
    const found = await get(subject, '/v1/fleet/assets/CLAUDE.md', admin);
    const absent = await get(subject, '/v1/fleet/assets/missing.md', admin);

    // Assert
    should(jsonBody(found)).match({ path: 'CLAUDE.md', content: 'be brief\n' });
    should(absent.status).equal(409);
    should(jsonBody(absent)).match({ code: 'fleet_asset_refused' });
  });
});
