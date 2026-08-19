import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FleetScaffolder } from '@ferretry/fleet';
import should from 'should';
import { StateFileSystem } from '../../../../src/adapters/filesystem/state-file-system.ts';
import { ProcfsSessionRootPinner } from '../../../../src/adapters/session/filesystem/index.ts';
import { MAX_TEXT_BODY_BYTES } from '../../../../src/lib/api/body.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { createFoundationPaths } from '../../../../src/lib/paths.ts';
import { createDaemonFleetSubsystem, fleetRoutes } from '../../../../src/lib/runtime/mounts/fleet.ts';
import { resolveStateHome } from '../../../../src/lib/state-home.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';
import { CapabilityGrantService, DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { CREDENTIALS, GOVERNED, GRANTED, harnessDiscoveryReader } from './support.ts';

const GENERATED_AT_MS = Date.parse('2027-01-15T08:00:00.000Z');
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const temporaryDirectories: string[] = [];

const admin = { authorization: `Bearer ${CREDENTIALS.admin}` } as const;
const warden = { authorization: `Bearer ${CREDENTIALS.warden}` } as const;
const device = { authorization: 'Bearer paired-device' } as const;

/**
 * The operator password this fixture's machine has, for the per-change confirmation.
 *
 * A literal in a test rather than a mint, because the confirmation is not a value this daemon
 * produces: it is one the operator already chose, and the whole point of the mechanism is that it is
 * the SAME secret the unlock is made of rather than a fresh one the host hands out.
 */
const OPERATOR_PASSWORD = 'the operator knows this';

interface Fixture {
  readonly paths: ReturnType<typeof createFoundationPaths>;
  readonly dispatcher: ApiDispatcher;
  readonly clock: { value: number };
  /** Every password this fixture was asked to confirm, so a test can assert what was spent. */
  readonly confirmed: string[];
}

interface FixtureOptions {
  readonly scaffolder?: FleetScaffolder;
  /**
   * Whether the caller is one the operator's grants govern — a paired browser off this host.
   *
   * Defaults to `false`, the owner's own case: the host's command line, or a browser on this machine
   * that has already unlocked. That caller is ungoverned by {@link isGovernedCaller} and therefore
   * owes no per-change confirmation, which is the whole of what this change was written to restore.
   */
  readonly governed?: boolean;
  /** The machine's password was removed between the boundary's read and the confirmation. */
  readonly cleared?: boolean;
  /** The daemon has stopped checking operator passwords for now — the shared unlock lockout. */
  readonly rateLimited?: boolean;
}

let minted = 1;

async function fixture(options: FixtureOptions | FleetScaffolder = {}): Promise<Fixture> {
  // The scaffolder used to be the only option, and several tests still pass one positionally.
  const settings: FixtureOptions = 'scaffold' in options ? { scaffolder: options } : options;
  const root = await mkdtemp(join(tmpdir(), 'fy-fleet-proposal-'));
  temporaryDirectories.push(root);
  const userHome = join(root, 'user');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: join(root, 'fy-home'), homeDirectory: userHome }));
  const clock = { value: GENERATED_AT_MS };
  const confirmed: string[] = [];
  const subsystem = createDaemonFleetSubsystem({
    ...(settings.scaffolder === undefined ? {} : { scaffolder: settings.scaffolder }),
    paths,
    userHome,
    clock: { now: () => clock.value },
    files: new StateFileSystem(paths),
    platform: 'linux',
    mintId: () => `proposal${String(minted++).padStart(14, '0')}`,
    // Deliberately in a range the fixture configuration never uses, so a minted account can never
    // collide with a declared one and make a create look like a duplicate.
    mintUuid: () => `00000000-0000-4000-8000-9${String(minted++).padStart(11, '0')}`,
    // Stands in for `CapabilityGrantService.confirmChange`. It records what it was asked, so a test
    // can prove the password reached the ONE place allowed to see it and nowhere else.
    confirmChange: async password => {
      confirmed.push(password);
      if (settings.rateLimited === true) return { kind: 'refused', reason: 'rate-limited' };
      if (settings.cleared === true) return { kind: 'refused', reason: 'no-password' };
      return password === OPERATOR_PASSWORD ? { kind: 'confirmed' } : { kind: 'refused', reason: 'wrong-password' };
    },
    rootPinner: new ProcfsSessionRootPinner(),
    clientName: 'fy',
    harnesses: harnessDiscoveryReader(),
  });
  const credentials = {
    ...CREDENTIALS,
    devices: { identify: (token: string) => (token === 'paired-device' ? 'device-1' : undefined) },
  };
  return {
    paths,
    clock,
    confirmed,
    dispatcher: new ApiDispatcher(
      new ApiRouter(fleetRoutes(subsystem)),
      credentials,
      settings.governed === true ? GOVERNED : GRANTED,
    ),
  };
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

  it('should refuse a body over the text bound before a byte of it is produced', async () => {
    // Arrange — the one fleet route whose purpose is to carry bulk caller-supplied text. Every
    // bound the asset edits state is enforced by a schema, and a schema reads a string the
    // transport has already held, so the read itself has to be the first bound.
    const subject = await fixture();
    await writeConfig(subject);
    const reads = bodyReads();

    // Act
    const actual = await subject.dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/fleet/proposals',
        headers: { ...admin, 'content-type': 'application/json', 'content-length': String(MAX_TEXT_BODY_BYTES + 1) },
        body: JSON.stringify(CREATE),
        reads,
      }),
    );

    // Assert — refused at the text ceiling, not the attachment one, and nothing was allocated.
    should(actual.status).equal(413);
    should(jsonBody(actual)).match({ code: 'body_too_large' });
    should(reads.limits).deepEqual([MAX_TEXT_BODY_BYTES]);
    should(reads.consumed).be.false();
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

    // Assert — refused where the contract is stated, before a byte of it is held, and the refusal
    // names the path it read rather than merely the field it was in.
    should(actual.status).equal(400);
    should(jsonBody(actual)).match({
      code: 'invalid_request',
      error: /asset path "\.\.\/\.\.\/escape\.md" contains a path traversal segment/u,
    });
  });

  it.each([
    ['an absolute file', { memory: '/etc/passwd' }, /"\/etc\/passwd" must be relative to the asset directory/u],
    ['a traversal', { memory: '../../../../etc/passwd' }, /contains a path traversal segment/u],
    ['a home directory', { skills: '~/.ssh' }, /"~\/\.ssh" must be relative to the asset directory, not to a home/u],
    ['a nested escape', { claude: { memory: '~/.ssh/id_ed25519' } }, /not to a home/u],
  ])('should refuse an overlay naming %s', async (_label, layer, expected) => {
    // Arrange — a paired device may compose a change, and applying copies whatever these fields
    // name into an account home. The line the host approves says only "add claude-atomi", so the
    // content of the change has to be bounded here rather than reviewed on a terminal.
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const actual = await post(subject, '/v1/fleet/proposals', device, {
      mutation: { ...CREATE.mutation, layer },
    });

    // Assert — refused before anything is held, and the refusal names the path it read.
    should(actual.status).equal(400);
    should(jsonBody(actual)).match({ code: 'invalid_request', error: expected });
  });

  it('should accept an overlay whose references stay inside the asset tree', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const proposal = await propose(subject, {
      mutation: { ...CREATE.mutation, layer: { memory: 'CLAUDE.md', skills: 'skills/atomi' } },
    });

    // Assert — the bound is on where a reference may point, not on composing a change at all.
    should(proposal.state).equal('pending');
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

describe('the authorization half, after it was deleted', () => {
  it('should serve no route that mints an approval for a change', async () => {
    // The whole `fy_fprop_` vocabulary lived behind this one route — a single-use eight-character
    // code, a 120-second life, five wrong tries — and it was a second authority system beside the
    // capability model, in a refusal vocabulary no other capability shared. It is gone, along with
    // the `fy fleet authorize` verb that dialled it, in one change: the route-agreement allowlist may
    // only shrink, so a half-deletion has no line it is permitted to record.
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);

    // Act
    const actual = await post(subject, `/v1/fleet/proposals/${proposal.id}/authorize`, admin);

    // Assert — 404 rather than 403: the route does not exist, which is a stronger statement than a
    // route that exists and refuses.
    should(actual.status).equal(404);
  });

  it('should report an unknown change as unknown and an expired one as expired', async () => {
    // The transaction's own refusals survive the authorization half's deletion untouched. A
    // timed-out change must still not send a person hunting for a typo in a correct id.
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject);

    // Act
    const unknown = await get(subject, '/v1/fleet/proposals/fy_fprop_never0000000000', admin);
    subject.clock.value += 16 * 60 * 1000;
    const expired = await get(subject, `/v1/fleet/proposals/${proposal.id}`, admin);

    // Assert
    should(jsonBody(unknown)).match({ code: 'fleet_proposal_unknown' });
    should(jsonBody(expired)).match({ code: 'fleet_proposal_expired' });
  });

  it('should never put an approval on a staged change, because the shape has no field for one', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const proposal = await propose(subject);
    const read = jsonBody(await get(subject, `/v1/fleet/proposals/${proposal.id}`, admin));

    // Assert — structurally absent rather than filtered, which is what stops it coming back.
    should(read).not.have.property('approval');
    should(JSON.stringify(read)).not.match(/approval/iu);
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

  it('should let a browser on this machine apply with no code, no proposal id and no timer', async () => {
    // THE OWNER'S OWN CASE, and the one the deleted mechanism made unbearable: a browser on this
    // host that has already unlocked is ungoverned by `isGovernedCaller`, so it applies exactly as
    // the host's command line does. Nothing is transcribed, nothing expires in 120 seconds, and the
    // request body is empty.
    // Arrange — `GRANTED` is the ungoverned caller; the default fixture.
    const subject = await fixture();
    await writeConfig(subject);
    const proposal = await propose(subject, CREATE, device);

    // Act — a paired-device credential, which is what a browser always holds, and NO body at all.
    const actual = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device);

    // Assert
    should([actual.status, jsonBody(actual)]).match([200, { outcome: 'committed' }]);
    // And the password was never asked for, because there was nothing standing behind one.
    should(subject.confirmed).deepEqual([]);
  });

  it('should refuse a governed caller that confirmed nothing, and accept the one that did', async () => {
    // A PAIRED REMOTE BROWSER, which since `PairingService.mint` began refusing without an operator
    // password is the only shape a remote caller comes in. Pairing is still not provisioning: the
    // credential alone applies nothing, and what closes the gap is the operator password proved
    // against this one staged change.
    // Arrange
    const subject = await fixture({ governed: true });
    await writeConfig(subject);
    const proposal = await propose(subject, CREATE, device);

    // Act
    const bare = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device);
    const confirmed = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, {
      operatorPassword: OPERATOR_PASSWORD,
    });

    // Assert
    should(jsonBody(bare)).match({ code: 'fleet_proposal_unauthorized' });
    should(jsonBody(bare)).match({ error: /operator password, entered against this exact change/u });
    should([confirmed.status, jsonBody(confirmed)]).match([200, { outcome: 'committed' }]);
    // Only the presented password reached the one port allowed to see one, and only once.
    should(subject.confirmed).deepEqual([OPERATOR_PASSWORD]);
  });

  it('should keep the change open when a governed caller confirms it wrongly', async () => {
    // A WRONG PASSWORD MUST NOT BURN THE CHANGE. Confirming happens BEFORE the consume for exactly
    // this reason: a mistyped password that spent somebody's staged change would make the mechanism
    // a denial of service against the person who is entitled to apply it.
    // Arrange
    const subject = await fixture({ governed: true });
    await writeConfig(subject);
    const proposal = await propose(subject, CREATE, device);

    // Act
    const wrong = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, {
      operatorPassword: 'not the operator password',
    });

    // Assert — nothing landed, and the change is still there to be applied by whoever has the
    // password. Asserted BEFORE the retry, because after it the manifest exists on purpose.
    should(jsonBody(wrong)).match({ code: 'fleet_proposal_unauthorized' });
    should(jsonBody(wrong)).match({ error: /not this machine's operator password/u });
    should(await Bun.file(subject.paths.fleetManifest).exists()).be.false();
    const retried = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, {
      operatorPassword: OPERATOR_PASSWORD,
    });
    should([retried.status, jsonBody(retried)]).match([200, { outcome: 'committed' }]);
  });

  it('should refuse a governed caller whose machine lost its password mid-change', async () => {
    // `fy daemon password clear` can run while a change is staged, so the boundary's `passwordSet`
    // and this confirmation can genuinely disagree. It is reported as itself rather than as a wrong
    // password, which would send somebody hunting for a secret the machine no longer has.
    // Arrange
    const subject = await fixture({ governed: true, cleared: true });
    await writeConfig(subject);
    const proposal = await propose(subject, CREATE, device);

    // Act
    const actual = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, {
      operatorPassword: OPERATOR_PASSWORD,
    });

    // Assert
    should(jsonBody(actual)).match({ code: 'fleet_proposal_unauthorized' });
    should(jsonBody(actual)).match({ error: /operator password was removed while/u });
  });

  it('should refuse a governed caller the daemon has stopped checking passwords for', async () => {
    // The lockout is the GRANT layer's, shared with the unlock rather than counted again here — so
    // five wrong guesses at this panel and five at the grants panel are five, not ten.
    // Arrange
    const subject = await fixture({ governed: true, rateLimited: true });
    await writeConfig(subject);
    const proposal = await propose(subject, CREATE, device);

    // Act
    const actual = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, {
      operatorPassword: OPERATOR_PASSWORD,
    });

    // Assert — and the change is still open, so the lockout costs a wait rather than the work.
    should(jsonBody(actual)).match({ code: 'fleet_proposal_unauthorized' });
    should(jsonBody(actual)).match({ error: /too many wrong operator passwords/u });
    should(
      (jsonBody(await get(subject, `/v1/fleet/proposals/${proposal.id}`, admin)) as { state: string }).state,
    ).equal('pending');
  });

  it('should refuse to apply for a caller it was told nothing about', async () => {
    // The served route always carries a governance, because it declares a capability and the
    // boundary builds one for every such route. This is the wiring failure: the safe reading of
    // "nobody can tell me where this caller stands" is not "write executables into their home".
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const mounted = createDaemonFleetSubsystem({
      paths: subject.paths,
      userHome: join(subject.paths.home, 'user'),
      clock: { now: () => GENERATED_AT_MS },
      files: new StateFileSystem(subject.paths),
      platform: 'linux',
      mintId: () => 'proposal00000000000001',
      mintUuid: () => '00000000-0000-4000-8000-000000000002',
      confirmChange: async () => ({ kind: 'confirmed' }),
      rootPinner: new ProcfsSessionRootPinner(),
      clientName: 'fy',
      harnesses: harnessDiscoveryReader(),
    });

    // Act
    const act = async (): Promise<unknown> => await mounted.applyProposal('fy_fprop_never0000000000', {}, undefined);

    // Assert
    await should(act()).be.rejectedWith(/cannot say whether this caller may change the fleet/u);
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

  it('should not let an empty confirmation spend the machine-wide password budget', async () => {
    // Offering nothing is not a guess. If it cost a try, a client with no password at all could burn
    // the five the operator gets — and that budget is per-DAEMON, so it would deny the grants panel
    // and every other surface at the same time.
    // Arrange
    const subject = await fixture({ governed: true });
    await writeConfig(subject);
    const proposal = await propose(subject, CREATE, device);

    // Act — far more empty attempts than any budget would allow, then the real password.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bare = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device);
      should(jsonBody(bare)).match({ code: 'fleet_proposal_unauthorized' });
    }
    const confirmed = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, {
      operatorPassword: OPERATOR_PASSWORD,
    });

    // Assert — the verifier was never consulted for an absent value, so nothing was spent.
    should(subject.confirmed).deepEqual([OPERATOR_PASSWORD]);
    should(jsonBody(confirmed)).match({ outcome: 'committed' });
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
      mutation: { ...CREATE.mutation, layer: { memory: 'nothing-is-here.md' } },
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

describe('replaying a confirmed change', () => {
  it('should refuse a change that timed out before it was confirmed', async () => {
    // The staged change's own fifteen minutes, which is a RESOURCE BOUND rather than an authority:
    // it exists so a client cannot make this daemon hold memory forever, and it survived the
    // authorization half's deletion untouched.
    // Arrange
    const subject = await fixture({ governed: true });
    await writeConfig(subject);
    const proposal = await propose(subject, CREATE, device);

    // Act
    subject.clock.value += 16 * 60 * 1000;
    const actual = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, {
      operatorPassword: 'not the operator password',
    });

    // Assert — refused as EXPIRED rather than as a wrong password, and the password was never even
    // presented to the verifier, so a change that timed out while somebody typed does not spend one
    // of the five tries the whole machine shares.
    should(jsonBody(actual)).match({ code: 'fleet_proposal_expired' });
    should(subject.confirmed).deepEqual([]);
  });

  it('should refuse a correct password replayed against a change already applied', async () => {
    // The confirmation is not a bearer value, so replaying it buys nothing: what is single-use is
    // the CHANGE, and it was spent by the apply that succeeded.
    // Arrange
    const subject = await fixture({ governed: true });
    await writeConfig(subject);
    const proposal = await propose(subject, CREATE, device);
    await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, { operatorPassword: OPERATOR_PASSWORD });

    // Act
    const replayed = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, device, {
      operatorPassword: OPERATOR_PASSWORD,
    });

    // Assert
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

  it('should name the claim it could not clear when preparation fails in a way nobody classified', async () => {
    // Arrange — a scaffolder that fails with something other than a partial host, and leaves the
    // exclusive claim unreadable on its way out. The file implementation reports every failure it
    // can reach as partial, so this is the branch no real adapter exercises and every other
    // implementation of the port owns.
    let lockPath = '';
    const subject = await fixture({
      scaffold: async () => {
        await mkdir(lockPath, { recursive: true });
        await writeFile(join(lockPath, 'claim-not-mine.json'), 'not a claim at all\n', 'utf8');
        throw new Error('the scaffolder fell over');
      },
    });
    lockPath = join(dirname(subject.paths.fleetManifest), '.fy-fleet-apply.lock');
    const proposal = await propose(subject, { mutation: { kind: 'initialize' } });

    // Act
    const actual = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);

    // Assert — a claim nobody cleared blocks the next apply whatever else happened, so it is named
    // rather than dropped along with the failure that produced it.
    should(actual.status).equal(409);
    should(jsonBody(actual)).match({
      code: 'fleet_apply_refused',
      error: /the scaffolder fell over; the exclusive apply claim at .*\.fy-fleet-apply\.lock could not be cleared/u,
    });
    should((await stat(lockPath)).isDirectory()).be.true();
  });

  it('should keep an unclassified preparation failure unclassified when nothing was left behind', async () => {
    // Arrange — the same failure, with a claim that released cleanly.
    const subject = await fixture({
      scaffold: () => Promise.reject(new Error('the scaffolder fell over')),
    });
    const proposal = await propose(subject, { mutation: { kind: 'initialize' } });

    // Act
    const actual = await post(subject, `/v1/fleet/proposals/${proposal.id}/apply`, admin);

    // Assert — nothing was left behind, so there is nothing to name and the failure stays a defect
    // rather than being dressed up as a refusal a person could act on.
    should(actual.status).equal(500);
    should(jsonBody(actual)).match({ code: 'internal_error' });
    should(await Bun.file(join(dirname(subject.paths.fleetManifest), '.fy-fleet-apply.lock')).exists()).be.false();
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

  it('should decide a paired device by the route declaration alone, never by an inline check', async () => {
    // FOUR INLINE `tokenClass === 'device'` REFUSALS USED TO LIVE IN THIS MOUNT, and they were the
    // last place in the daemon where a handler re-decided the axis its own route already declares.
    // What answers now is the capability guard: `GRANTED` speaks for an ungoverned caller, so every
    // one of these is served, and the SAME code refuses under a guard that says otherwise.
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const reads = await Promise.all([
      get(subject, '/v1/fleet/permissions', device),
      get(subject, '/v1/fleet/assets', device),
      get(subject, '/v1/fleet/environment', device),
    ]);
    const environment = await subject.dispatcher.dispatch(
      request({
        method: 'PUT',
        path: '/v1/fleet/environment',
        headers: { ...device, 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'default', environment: { EDITOR: 'vi' }, mode: 'merge' }),
      }),
    );

    // Assert — a device is no longer singled out anywhere in this file; the grant decides. The
    // environment write is asserted as NOT-403 rather than as 200: whether this particular payload
    // is portable is the environment editor's own question, and answering it here would make this
    // test pass or fail for a reason that has nothing to do with who the caller is.
    should(reads.map(response => response.status)).deepEqual([200, 200, 200]);
    should(environment.status).not.equal(403);
  });

  it.each(endpoints)('should answer %s %s with no-store', async (method, path) => {
    // Arrange — every one of these discloses host paths or a staged change.
    const subject = await fixture();

    // Act
    const actual = await subject.dispatcher.dispatch(request({ method, path, headers: admin }));

    // Assert
    should(actual.headers.get('cache-control')).match(/no-store/u);
  });
});

describe('reading what a caller may do', () => {
  it('should say the same thing the boundary would, in the shared grant vocabulary', async () => {
    // Said BEFORE a click, so the panel never offers a control that ends in a refusal — and said in
    // the vocabulary every other capability-governed surface uses, rather than the fleet's own.
    // Arrange
    const ungoverned = await fixture();
    const governed = await fixture({ governed: true });

    // Act
    const local = jsonBody(await get(ungoverned, '/v1/fleet/permissions', device));
    const remote = jsonBody(await get(governed, '/v1/fleet/permissions', device));

    // Assert — the local browser is asked for nothing more; the remote one confirms each change.
    should(local).deepEqual({
      mayInspect: true,
      mayPropose: true,
      mayApply: true,
      applyRefusal: 'granted',
      confirmation: 'none',
    });
    should(remote).deepEqual({
      mayInspect: true,
      mayPropose: true,
      mayApply: true,
      applyRefusal: 'granted',
      confirmation: 'operator-password',
    });
    // And there is nothing left in the shape that names a code or a command to run on the host.
    should(JSON.stringify(local)).not.match(/approval|authorize/iu);
  });

  it('should offer nothing to a caller it was told nothing about', async () => {
    // The permissions read is a courtesy, and a courtesy must not invent authority out of missing
    // evidence. It cannot happen through the served route, which declares a capability — but an
    // absent answer must render as a closed panel, never as an open Apply button.
    // Arrange
    const subject = await fixture();
    const mounted = createDaemonFleetSubsystem({
      paths: subject.paths,
      userHome: join(subject.paths.home, 'user'),
      clock: { now: () => GENERATED_AT_MS },
      files: new StateFileSystem(subject.paths),
      platform: 'linux',
      mintId: () => 'proposal00000000000000',
      mintUuid: () => '00000000-0000-4000-8000-000000000001',
      confirmChange: async () => ({ kind: 'confirmed' }),
      rootPinner: new ProcfsSessionRootPinner(),
      clientName: 'fy',
      harnesses: harnessDiscoveryReader(),
    });

    // Act
    const actual = mounted.permissions(undefined);

    // Assert
    should(actual).deepEqual({
      mayInspect: false,
      mayPropose: false,
      mayApply: false,
      applyRefusal: 'undetermined',
      confirmation: 'none',
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

describe('a paired browser, against the real capability guard', () => {
  /**
   * The fleet route table in front of the REAL `CapabilityGrantService`, not a stub.
   *
   * Every other test in this file drives a hand-written guard, which proves the mount honours what it
   * is told. This proves what it is actually told — that `isGovernedCaller`, `decideCapability` and
   * the unlock ledger, wired exactly as the composition root wires them, refuse a paired browser that
   * is not on this host. A stub can be made to say anything; this cannot.
   */
  async function governedWorld(options: { readonly password?: string } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'fy-fleet-governed-'));
    temporaryDirectories.push(root);
    const userHome = join(root, 'user');
    const paths = createFoundationPaths(resolveStateHome({ fyHome: join(root, 'fy-home'), homeDirectory: userHome }));
    let stored = options.password;
    let unlocks = 0;
    const grants = new CapabilityGrantService({
      document: { read: async () => DEFAULT_CAPABILITY_GRANTS, written: async () => [], write: async () => undefined },
      passwords: {
        isSet: async () => stored !== undefined,
        set: async password => {
          stored = password;
        },
        clear: async () => {
          stored = undefined;
        },
        verify: async candidate => stored !== undefined && candidate === stored,
      },
      tokens: {
        mint: () => {
          unlocks += 1;
          return `fy_unlock_${String(unlocks).padStart(22, 'u')}`;
        },
      },
      clock: { nowMs: () => GENERATED_AT_MS },
      audit: { record: async () => undefined, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
      clientName: 'fy',
    });
    await grants.refresh();
    const subsystem = createDaemonFleetSubsystem({
      paths,
      userHome,
      clock: { now: () => GENERATED_AT_MS },
      files: new StateFileSystem(paths),
      platform: 'linux',
      mintId: () => `proposal${String(minted++).padStart(14, '0')}`,
      mintUuid: () => `00000000-0000-4000-8000-8${String(minted++).padStart(11, '0')}`,
      confirmChange: async password => await grants.confirmChange(password),
      rootPinner: new ProcfsSessionRootPinner(),
      clientName: 'fy',
      harnesses: harnessDiscoveryReader(),
    });
    const credentials = {
      ...CREDENTIALS,
      devices: { identify: (token: string) => (token === 'paired-device' ? 'device-1' : undefined) },
    };
    const subject: Fixture = {
      paths,
      clock: { value: GENERATED_AT_MS },
      confirmed: [],
      dispatcher: new ApiDispatcher(new ApiRouter(fleetRoutes(subsystem)), credentials, grants),
    };
    await writeConfig(subject);
    return { subject, grants };
  }

  /** A relayed request. `loopback: false` is the carrier's own answer and no header can move it. */
  const remotely = (path: string, body?: unknown, unlock?: string) =>
    request({
      method: 'POST',
      path,
      loopback: false,
      headers: {
        authorization: 'Bearer paired-device',
        // Every header a caller could hope re-derives locality. None of them can: `loopback` comes
        // from the socket, and the relay tunnel sets it `false` unconditionally.
        host: '127.0.0.1:7777',
        'x-forwarded-for': '127.0.0.1',
        ...(unlock === undefined ? {} : { 'x-ferretry-operator-unlock': unlock }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('should refuse a remote paired browser that has not proved the operator password', async () => {
    // THE PROPERTY THAT MUST NOT REGRESS. A fleet apply writes executable wrappers into the user's
    // home and prunes files carrying Ferretry's marker, so a device must not provision a host on the
    // strength of having paired. What refuses it is `decideCapability`'s `locked` branch, reached
    // because `isGovernedCaller` reads `loopback: false` from the carrier.
    // Arrange
    const { subject } = await governedWorld({ password: 'the operator knows this' });
    const staged = await subject.dispatcher.dispatch(
      remotely('/v1/fleet/proposals', CREATE) as ReturnType<typeof request>,
    );
    const proposal = jsonBody(staged) as { id: string };

    // Act
    const applied = await subject.dispatcher.dispatch(remotely(`/v1/fleet/proposals/${proposal.id}/apply`));

    // Assert — composing is `fleet.use` and touches nothing, so it is served; applying is not.
    should(staged.status).equal(200);
    should(applied.status).equal(403);
    should(jsonBody(applied)).match({ code: 'grant_locked' });
    should(await Bun.file(subject.paths.fleetManifest).exists()).be.false();
  });

  it('should still refuse a remote browser holding a valid unlock but confirming nothing', async () => {
    // THE PER-CHANGE CONFIRMATION, PROVED. An unlock is a five-minute bearer value; on its own it is
    // not enough to write executables into somebody's home. This is the step that makes a borrowed
    // unlock insufficient.
    // Arrange
    const { subject, grants } = await governedWorld({ password: 'the operator knows this' });
    const unlocked = await grants.unlock('the operator knows this');
    should(unlocked.kind).equal('unlocked');
    const token = unlocked.kind === 'unlocked' ? unlocked.token : '';
    const proposal = jsonBody(await subject.dispatcher.dispatch(remotely('/v1/fleet/proposals', CREATE, token))) as {
      id: string;
    };

    // Act
    const bare = await subject.dispatcher.dispatch(
      remotely(`/v1/fleet/proposals/${proposal.id}/apply`, undefined, token),
    );
    const confirmed = await subject.dispatcher.dispatch(
      remotely(`/v1/fleet/proposals/${proposal.id}/apply`, { operatorPassword: 'the operator knows this' }, token),
    );

    // Assert
    should(jsonBody(bare)).match({ code: 'fleet_proposal_unauthorized' });
    should([confirmed.status, jsonBody(confirmed)]).match([200, { outcome: 'committed' }]);
  });

  it('should refuse a remote browser that never unlocked, however local its headers claim to be', async () => {
    // A `Host` header, an `x-forwarded-for` and a `127.0.0.1` in the URL are all present on every
    // request this describe block sends. None of them moves `loopback`, which is the worst bug this
    // design could produce and the reason the value is carrier-derived.
    // Arrange
    const { subject } = await governedWorld({ password: 'the operator knows this' });

    // Act
    const view = await subject.dispatcher.dispatch(
      request({ path: '/v1/fleet/permissions', loopback: false, headers: { authorization: 'Bearer paired-device' } }),
    );

    // Assert — and the panel is TOLD, before a click, that it is locked and why.
    should(jsonBody(view)).deepEqual({
      mayInspect: true,
      mayPropose: true,
      mayApply: false,
      applyRefusal: 'locked',
      confirmation: 'operator-password',
    });
  });

  it('should tell a local browser that has NOT unlocked that the password is the whole remedy', async () => {
    // THE OWNER'S SCREENSHOT, at the daemon. `#358` made a local browser a governed caller until it
    // unlocks, so this is the state the panel was in when it showed `grant_locked` — and the only
    // thing the daemon says about it is `locked`, whose remedy is a password the reader may already
    // have. It never was, and is not now, a reason to print a command to run in a terminal.
    // Arrange
    const { subject } = await governedWorld({ password: 'the operator knows this' });
    const locally = { authorization: 'Bearer paired-device' } as const;

    // Act
    const permissions = jsonBody(
      await subject.dispatcher.dispatch(request({ path: '/v1/fleet/permissions', loopback: true, headers: locally })),
    );
    const proposal = jsonBody(
      await subject.dispatcher.dispatch(
        request({
          method: 'POST',
          path: '/v1/fleet/proposals',
          loopback: true,
          headers: { ...locally, 'content-type': 'application/json' },
          body: JSON.stringify(CREATE),
        }),
      ),
    ) as { id: string };
    const applied = await subject.dispatcher.dispatch(
      request({ method: 'POST', path: `/v1/fleet/proposals/${proposal.id}/apply`, loopback: true, headers: locally }),
    );

    // Assert — staging is `fleet.use` and is served; applying is `locked`, in the shared vocabulary.
    should(permissions).match({ mayApply: false, applyRefusal: 'locked' });
    should(applied.status).equal(403);
    should(jsonBody(applied)).match({ code: 'grant_locked' });
    should(await Bun.file(subject.paths.fleetManifest).exists()).be.false();
  });

  it('should let a browser on this machine apply once it has unlocked, and ask for nothing more', async () => {
    // `#358`'s shape, end to end through the real guard: a local browser is a paired device and is
    // governed until it presents an unlock — then ungoverned COMPLETELY, with no second gate and no
    // per-action prompt. That is what the owner asked for and what the deleted approval flow broke.
    // Arrange
    const { subject, grants } = await governedWorld({ password: 'the operator knows this' });
    const unlocked = await grants.unlock('the operator knows this');
    const token = unlocked.kind === 'unlocked' ? unlocked.token : '';
    const locally = (path: string, body?: unknown) =>
      request({
        method: 'POST',
        path,
        loopback: true,
        headers: {
          authorization: 'Bearer paired-device',
          'x-ferretry-operator-unlock': token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const proposal = jsonBody(await subject.dispatcher.dispatch(locally('/v1/fleet/proposals', CREATE))) as {
      id: string;
    };

    // Act — no password in the body, and no code anywhere.
    const applied = await subject.dispatcher.dispatch(locally(`/v1/fleet/proposals/${proposal.id}/apply`));
    const permissions = jsonBody(
      await subject.dispatcher.dispatch(
        request({
          path: '/v1/fleet/permissions',
          loopback: true,
          headers: { authorization: 'Bearer paired-device', 'x-ferretry-operator-unlock': token },
        }),
      ),
    );

    // Assert
    should([applied.status, jsonBody(applied)]).match([200, { outcome: 'committed' }]);
    should(permissions).match({ mayApply: true, applyRefusal: 'granted', confirmation: 'none' });
    should(JSON.stringify(permissions)).not.match(/approval|authorize/iu);
  });

  it('should ask a caller on a machine with no operator password for nothing at all', async () => {
    // No secret exists to bind a change to, so there is deliberately no prompt: a control that
    // cannot refuse is theatre. The capability layer reports `ungated` rather than `granted` so the
    // panel can say once, beside the control, that nothing is standing behind it.
    // Arrange
    const { subject } = await governedWorld();

    // Act
    const proposal = jsonBody(await subject.dispatcher.dispatch(remotely('/v1/fleet/proposals', CREATE))) as {
      id: string;
    };
    const applied = await subject.dispatcher.dispatch(remotely(`/v1/fleet/proposals/${proposal.id}/apply`));
    const permissions = jsonBody(
      await subject.dispatcher.dispatch(
        request({ path: '/v1/fleet/permissions', loopback: false, headers: { authorization: 'Bearer paired-device' } }),
      ),
    );

    // Assert — and this state is not reachable by pairing: a machine with no operator password
    // refuses to hand out a pairing code at all (`PairingService.mint`). It is reachable only by an
    // operator who paired a device and then ran `fy daemon password clear`.
    should([applied.status, jsonBody(applied)]).match([200, { outcome: 'committed' }]);
    should(permissions).match({ mayApply: true, applyRefusal: 'ungated', confirmation: 'none' });
  });
});
