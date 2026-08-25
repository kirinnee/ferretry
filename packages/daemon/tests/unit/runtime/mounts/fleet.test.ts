import { afterEach, describe, it } from 'bun:test';
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FleetApplyPlan,
  type FleetApplyPreview,
  FleetConfigSchema,
  FleetHealthSnapshotSchema,
  FleetManifestSchema,
  FleetUsageSnapshotSchema,
} from '@ferretry/fleet';
import type { HarnessDiscoveryReport } from '@ferretry/protocol';
import should from 'should';
import { StateFileSystem } from '../../../../src/adapters/filesystem/state-file-system.ts';
import { ProcfsSessionRootPinner } from '../../../../src/adapters/session/filesystem/index.ts';
import type { CapabilityGuard } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { FleetAccountHealthService } from '../../../../src/lib/fleet-health/index.ts';
import { createFoundationPaths } from '../../../../src/lib/paths.ts';
import { createDaemonFleetSubsystem, fleetRoutes } from '../../../../src/lib/runtime/mounts/fleet.ts';
import { resolveStateHome } from '../../../../src/lib/state-home.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, harnessDiscoveryReader, human, NARROWED } from './support.ts';

const GENERATED_AT_MS = Date.parse('2027-01-15T08:00:00.000Z');
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ACCOUNT_ID = '00000000-0000-4000-8000-000000000002';
const temporaryDirectories: string[] = [];

interface FleetFixture {
  readonly root: string;
  readonly userHome: string;
  readonly paths: ReturnType<typeof createFoundationPaths>;
  readonly dispatcher: ApiDispatcher;
}

/** Shared counter behind the deterministic identity a fixture mints. */
let minted = 1;

async function fixture(
  options: { readonly guard?: CapabilityGuard; readonly accountHealth?: FleetAccountHealthService } = {},
): Promise<FleetFixture> {
  const root = await mkdtemp(join(tmpdir(), 'fy-daemon-fleet-route-'));
  temporaryDirectories.push(root);
  const userHome = join(root, 'user');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: join(root, 'fy-home'), homeDirectory: userHome }));
  // A platform is required rather than defaulted, so a test always states which credential path it
  // drives. No usage probe is injected, so the route builds the real one; it finds no credential in
  // this temporary home, which is the honest 'not logged in' answer rather than a fabricated zero.
  const subsystem = createDaemonFleetSubsystem({
    paths,
    userHome,
    clock: { now: () => GENERATED_AT_MS },
    files: new StateFileSystem(paths),
    platform: 'linux',
    // Counted rather than random, so a proposal handle and an account id are both assertable.
    mintId: () => `proposal${String(minted++).padStart(14, '0')}`,
    mintUuid: () => `00000000-0000-4000-8000-${String(minted++).padStart(12, '0')}`,
    confirmChange: async () => ({ kind: 'confirmed' }),
    rootPinner: new ProcfsSessionRootPinner(),
    clientName: 'fy',
    harnesses: harnessDiscoveryReader(),
    ...(options.accountHealth === undefined ? {} : { accountHealth: options.accountHealth }),
  });
  const credentials = {
    ...CREDENTIALS,
    devices: { identify: (token: string) => (token === 'paired-device' ? 'device-1' : undefined) },
  };
  return {
    root,
    userHome,
    paths,
    dispatcher: new ApiDispatcher(new ApiRouter(fleetRoutes(subsystem)), credentials, options.guard ?? GRANTED),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const configYaml = `
profiles:
  portable:
    env:
      LOG_LEVEL: debug
      FEATURE_MODE: safe
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

async function writeConfig(subject: FleetFixture, content = configYaml): Promise<void> {
  await mkdir(subject.paths.fleet, { recursive: true });
  await writeFile(join(subject.paths.fleet, 'config.yaml'), content, 'utf8');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('the daemon fleet mount', () => {
  it('should build ONE health service per mount, and share one credential store with the quota probe', async () => {
    // Arrange — the service serializes its own writes to one document, so two instances would each
    // hold their own queue over the same file. That is the lost-update the success-only cache it
    // replaces suffered from. The credential store is shared because on macOS each one is a keychain
    // lookup per account, and asking twice per pass for the same bytes is pure cost.
    const root = await mkdtemp(join(tmpdir(), 'fy-daemon-fleet-health-service-'));
    temporaryDirectories.push(root);
    const userHome = join(root, 'user');
    const paths = createFoundationPaths(resolveStateHome({ fyHome: join(root, 'fy-home'), homeDirectory: userHome }));
    const subsystem = createDaemonFleetSubsystem({
      paths,
      userHome,
      clock: { now: () => GENERATED_AT_MS },
      files: new StateFileSystem(paths),
      platform: 'linux',
      mintId: () => 'proposal00000000000000',
      mintUuid: () => '00000000-0000-4000-8000-000000000001',
      confirmChange: async () => ({ kind: 'confirmed' }),
      rootPinner: new ProcfsSessionRootPinner(),
      clientName: 'fy',
      harnesses: harnessDiscoveryReader(),
    }) as unknown as {
      accountHealth(): unknown;
      credentialStore(): unknown;
    };

    // Act / Assert
    should(subsystem.accountHealth()).equal(subsystem.accountHealth());
    should(subsystem.credentialStore()).equal(subsystem.credentialStore());
  });

  it('should preview and atomically apply only portable profile environment, with explicit merge and replace', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const before = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/environment', headers: human }));
    const merged = await subject.dispatcher.dispatch(
      request({
        method: 'PUT',
        path: '/v1/fleet/environment',
        headers: human,
        body: JSON.stringify({ profile: 'portable', mode: 'merge', environment: { LOG_LEVEL: 'trace', RETRIES: '3' } }),
      }),
    );
    const replaced = await subject.dispatcher.dispatch(
      request({
        method: 'PUT',
        path: '/v1/fleet/environment',
        headers: human,
        body: JSON.stringify({ profile: 'portable', mode: 'replace', environment: { RETRIES: '5' } }),
      }),
    );

    // Assert — merge overwrites source collisions and keeps target-only keys; replace removes them.
    should(JSON.parse(before.body)).deepEqual({ profiles: { portable: { LOG_LEVEL: 'debug', FEATURE_MODE: 'safe' } } });
    should(JSON.parse(merged.body)).deepEqual({
      profiles: { portable: { LOG_LEVEL: 'trace', FEATURE_MODE: 'safe', RETRIES: '3' } },
    });
    should(JSON.parse(replaced.body)).deepEqual({ profiles: { portable: { RETRIES: '5' } } });
    const written = FleetConfigSchema.parse(
      Bun.YAML.parse(await readFile(join(subject.paths.fleet, 'config.yaml'), 'utf8')),
    );
    should(written.profiles.portable?.env).deepEqual({ RETRIES: '5' });
  });

  it('should refuse credentials and machine-bound values instead of treating them as portable configuration', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const credential = await subject.dispatcher.dispatch(
      request({
        method: 'PUT',
        path: '/v1/fleet/environment',
        headers: human,
        body: JSON.stringify({
          profile: 'portable',
          mode: 'merge',
          environment: { ANTHROPIC_API_KEY: 'not-a-real-key' },
        }),
      }),
    );
    const path = await subject.dispatcher.dispatch(
      request({
        method: 'PUT',
        path: '/v1/fleet/environment',
        headers: human,
        body: JSON.stringify({ profile: 'portable', mode: 'merge', environment: { CACHE_DIR: '/host-only' } }),
      }),
    );

    // Assert
    should(credential.status).equal(409);
    should(JSON.parse(credential.body)).have.property('code', 'fleet_environment_refused');
    should(path.status).equal(409);
    should(JSON.parse(path.body)).have.property('code', 'fleet_environment_refused');
  });

  /**
   * The one credential-named entry that travels, and the reason it is not a contradiction: it names a
   * secret rather than carrying one, and the value stays in whichever daemon's store resolves it.
   * Before this, the refusal above meant a fleet could not express an API key through this surface at
   * all — which is exactly what a profile authenticating an account is for.
   */
  it('should let a credential-named variable travel when its value names a stored secret', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const stored = await subject.dispatcher.dispatch(
      request({
        method: 'PUT',
        path: '/v1/fleet/environment',
        headers: human,
        body: JSON.stringify({
          profile: 'portable',
          mode: 'merge',
          environment: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' },
        }),
      }),
    );
    const read = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/environment', headers: human }));

    // Assert — a reference, on the way in and on the way back out. Never a value.
    should(stored.status).equal(200);
    should(jsonBody(read)).match({ profiles: { portable: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } } });
  });

  it('should still refuse a credential-named variable whose value only looks like a reference', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const response = await subject.dispatcher.dispatch(
      request({
        method: 'PUT',
        path: '/v1/fleet/environment',
        headers: human,
        body: JSON.stringify({
          profile: 'portable',
          mode: 'merge',
          environment: { ANTHROPIC_API_KEY: '${secret:work_key}' },
        }),
      }),
    );

    // Assert
    should(response.status).equal(409);
    should(JSON.parse(response.body)).have.property('code', 'fleet_environment_refused');
  });

  it('should refuse a configure-axis change through the grant rather than through the token class', async () => {
    // THE SAME REQUEST, TWO GUARDS. It used to be refused by an inline `tokenClass === 'device'` in
    // the handler, which meant the refusal was invisible to the route table and to `GrantsView` and
    // no surface could explain it before somebody clicked. Now the operator's answer decides, and
    // the refusal arrives in the shared `grant_*` vocabulary with a sentence naming the next step.
    // Arrange
    const permitted = await fixture();
    const refused = await fixture({ guard: NARROWED });
    await Promise.all([writeConfig(permitted), writeConfig(refused)]);
    const write = (headers: Readonly<Record<string, string>>) =>
      request({
        method: 'PUT',
        path: '/v1/fleet/environment',
        headers,
        body: JSON.stringify({ profile: 'portable', mode: 'replace', environment: {} }),
      });
    const device = { authorization: 'Bearer paired-device', 'x-ferretry-client': 'ui' } as const;

    // Act
    const served = await permitted.dispatcher.dispatch(write(device));
    const denied = await refused.dispatcher.dispatch(write(device));

    // Assert
    should(served.status).equal(200);
    should(denied.status).equal(403);
    should(jsonBody(denied)).match({ code: 'grant_not_granted', error: /daemon config set fleet --configure/u });
  });

  it('should require an authenticated operator credential before anything at all', async () => {
    // The route's own contract, which the grant layer is stacked on top of rather than merged into:
    // a grant is consulted only once the credential minimum has already passed, so it can only ever
    // take authority away.
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const device = { authorization: 'Bearer paired-device', 'x-ferretry-client': 'ui' } as const;
    const warden = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

    // Act
    const anonymous = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/plan' }));
    const scoped = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/plan', headers: warden }));
    const deviceRead = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/plan', headers: device }));

    // Assert
    should(anonymous.status).equal(401);
    should(scoped.status).equal(403);
    should(deviceRead.status).equal(200);
    should(await fileExists(subject.paths.fleetManifest)).be.false();
  });

  it('should refuse an absent or damaged manifest instead of rendering an empty fleet', async () => {
    // Arrange
    const subject = await fixture();

    // Act
    const missing = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/accounts', headers: human }));
    await mkdir(subject.paths.fleet, { recursive: true });
    await writeFile(subject.paths.fleetManifest, '{"version":"damaged"}\n', 'utf8');
    const damaged = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/accounts', headers: human }));

    // Assert
    should(missing.status).equal(409);
    should(jsonBody(missing)).have.property('code', 'fleet_not_applied');
    should(jsonBody(missing).error).match(/apply the fleet first/u);
    should(damaged.status).equal(409);
    should(jsonBody(damaged)).have.property('code', 'fleet_manifest_invalid');
  });

  it('should serve what this host has, held to the shared contract, without a published fleet', async () => {
    // Arrange — NO manifest and NO config. This read is deliberately independent of both: somebody
    // installing Claude Code for the first time has a host that knows something and a fleet that knows
    // nothing, and they are exactly the person the account form has to fill itself in for.
    const subject = await fixture();

    // Act
    const answer = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/harnesses', headers: human }));

    // Assert — parsed through `HarnessDiscoveryReportSchema` on the way out, so this side fails loudly
    // if the answer ever stops matching the shape the browser reads.
    should(answer.status).equal(200);
    const report = jsonBody(answer) as HarnessDiscoveryReport;
    should(report.harnesses.map(harness => harness.kind)).deepEqual(['claude', 'codex']);
    should(report.harnesses[0]?.command).equal('/usr/local/bin/claude');
    should(report.harnesses[1]?.command).be.undefined();
    should(report.noneInstalled).be.false();
    should(answer.headers.get('cache-control')).match(/no-store/u);
  });

  it('should refuse the harness read to a credential that may not read the fleet', async () => {
    // Arrange — the answer names absolute paths in somebody's home and the text of their instructions
    // document, which is the same class of disclosure as a wrapper path. So it sits behind the same
    // capability as every other fleet read rather than being quietly ungated because it is "just a probe".
    const subject = await fixture();

    // Act
    const answer = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/harnesses' }));

    // Assert
    should(answer.status).equal(401);
  });

  it('should refuse an absent or damaged declared config before planning or applying', async () => {
    // Arrange
    const subject = await fixture();

    // Act
    const missing = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/config', headers: human }));
    await writeConfig(subject, 'agents: definitely-not-a-list\n');
    const damaged = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/plan', headers: human }));

    // Assert
    should(missing.status).equal(409);
    should(jsonBody(missing)).have.property('code', 'fleet_config_missing');
    should(damaged.status).equal(409);
    should(jsonBody(damaged)).have.property('code', 'fleet_config_invalid');
    should(await fileExists(subject.paths.fleetManifest)).be.false();
  });

  it('should expose the validated config and the exact shared-library plan', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const configResponse = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/config', headers: human }));
    const planResponse = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/plan', headers: human }));

    // Assert
    should(configResponse.status).equal(200);
    const config = FleetConfigSchema.parse(JSON.parse(configResponse.body));
    should(config.agents[0]?.routes.default?.id).equal(ACCOUNT_ID);
    should(config.usage.enabled).be.true();
    should(planResponse.status).equal(200);
    const plan = JSON.parse(planResponse.body) as FleetApplyPlan;
    should(plan.manifest.generatedAt).equal('2027-01-15T08:00:00.000Z');
    should(plan.manifestPath).equal(subject.paths.fleetManifest);
    should(plan.manifest.accounts[0]?.home).equal(join(subject.paths.fleet, 'homes', 'claude-work'));
    should(
      plan.operations.some(operation => operation.kind === 'file' && operation.path.endsWith('/fy-claude-work')),
    ).be.true();
    should(await fileExists(subject.paths.fleetManifest)).be.false();
  });

  it('should preview an exact history collision and then migrate the same disposable homes', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(
      subject,
      `
sharedHistory:
  claude: true
agents:
  - name: first
    kind: claude
    routes:
      default:
        id: ${ACCOUNT_ID}
        wrapper: fy-claude-first
        home: claude-first
        defaultModel: opus
        models: [opus]
  - name: second
    kind: claude
    routes:
      default:
        id: ${SECOND_ACCOUNT_ID}
        wrapper: fy-claude-second
        home: claude-second
        defaultModel: opus
        models: [opus]
`,
    );
    const homeA = join(subject.paths.fleet, 'homes', 'claude-first');
    const homeB = join(subject.paths.fleet, 'homes', 'claude-second');
    const fileA = join(homeA, 'projects', 'project', 'conversation.jsonl');
    const fileB = join(homeB, 'projects', 'project', 'conversation.jsonl');
    await mkdir(join(homeA, 'projects', 'project'), { recursive: true });
    await mkdir(join(homeB, 'projects', 'project'), { recursive: true });
    await writeFile(fileA, 'older\n', 'utf8');
    await writeFile(fileB, 'newer\n', 'utf8');
    await utimes(fileA, 10, 10);
    await utimes(fileB, 20, 20);
    const pool = join(subject.paths.fleet, 'shared', 'claude');
    const pooledFile = join(pool, 'projects', 'project', 'conversation.jsonl');
    // The pooled loser belongs to the first account, so that is the identity it is quarantined under.
    const preserved = join(pool, '.migration-conflicts', ACCOUNT_ID, 'projects', 'project', 'conversation.jsonl');

    // Act
    const previewResponse = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/plan', headers: human }));
    const preview = JSON.parse(previewResponse.body) as FleetApplyPreview;
    const beforeApply = await lstat(join(homeA, 'projects'));
    const appliedResponse = await subject.dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/fleet/apply', headers: human }),
    );

    // Assert — GET /plan observed and named the winner without touching either source.
    should(previewResponse.status).equal(200);
    const collision = preview.sharedHistory[0]?.changes.find(change => change.kind === 'collision');
    should(collision).deepEqual({
      kind: 'collision',
      incoming: fileB,
      pooled: pooledFile,
      winner: fileB,
      loser: pooledFile,
      preservedAt: preserved,
    });
    should(beforeApply.isDirectory()).be.true();

    // POST /apply performed that outcome and returned the same exact migration evidence.
    should(appliedResponse.status).equal(200);
    const applied = jsonBody(appliedResponse) as { sharedHistory: FleetApplyPreview['sharedHistory'] };
    should(applied.sharedHistory[0]?.changes).containDeep([collision]);
    should((await lstat(join(homeA, 'projects'))).isSymbolicLink()).be.true();
    should((await lstat(join(homeB, 'projects'))).isSymbolicLink()).be.true();
    should(await readlink(join(homeA, 'projects'))).equal(join(pool, 'projects'));
    should(await readlink(join(homeB, 'projects'))).equal(join(pool, 'projects'));
    should(await readFile(pooledFile, 'utf8')).equal('newer\n');
    should(await readFile(preserved, 'utf8')).equal('older\n');
  });

  it('should apply only inside disposable roots and then serve manifest and honest usage evidence', async () => {
    // Arrange — both FY_HOME and the supplied user home are children of this disposable root.
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const applied = await subject.dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/fleet/apply', headers: human }),
    );
    const accountsResponse = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/accounts', headers: human }));
    const usageResponse = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/usage', headers: human }));
    const healthResponse = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/health', headers: human }));

    // Assert
    should(applied.status).equal(200);
    should(jsonBody(applied)).have.property('accountCount', 1);
    const wrapper = join(subject.paths.fleet, 'bin', 'fy-claude-work');
    should(await readFile(wrapper, 'utf8')).match(/CLAUDE_CONFIG_DIR/u);
    const manifest = FleetManifestSchema.parse(JSON.parse(accountsResponse.body));
    should(manifest.accounts.map(account => account.id)).deepEqual([ACCOUNT_ID]);
    should(manifest.accounts[0]?.wrapper).equal(wrapper);
    const usage = FleetUsageSnapshotSchema.parse(JSON.parse(usageResponse.body));
    should(usage.at).equal(GENERATED_AT_MS);
    // The route now builds the real Anthropic probe. This home has no credential, so the honest
    // answer is a failed reading with a reason — and, importantly, NOT at its limit: an account
    // nobody could read is unknown, not exhausted. The previous placeholder reported every account
    // `unavailable`, which the collector then read as at-limit and would have blocked all routing.
    should(usage.accounts[0]).containEql({
      accountId: ACCOUNT_ID,
      provider: 'anthropic',
      ok: false,
      authOk: false,
      atLimit: false,
    });
    should(usage.accounts[0]?.error).match(/no readable access token/u);
    // The health read is a STORE read. Reaching `/v1/fleet/usage` above already recorded a verdict —
    // because health rides that collection and adds no request of its own — so by the time this line
    // runs the account has been checked, and this home has no credential, which is a re-login.
    const health = FleetHealthSnapshotSchema.parse(JSON.parse(healthResponse.body));
    should(healthResponse.status).equal(200);
    should(health.accounts[0]?.accountId).equal(ACCOUNT_ID);
    should(health.accounts[0]?.verdict).equal('needs_relogin');
    should(health.accounts[0]?.lastCheckedAt).equal(GENERATED_AT_MS);
    should(wrapper.startsWith(subject.root)).be.true();
    should(subject.paths.fleetManifest.startsWith(subject.root)).be.true();
  });

  /**
   * A FAILED HEALTH WRITE MUST NOT FAIL THE QUOTA READ. This is the live counterpart to the service
   * propagating its failure: the `.catch()` in `usage()` is the thing under test, and without this it
   * would be a decorative handler that could never fire.
   *
   * The feed, the advisor and the warden are all waiting on this snapshot and none of them asked about
   * health, so `GET /v1/fleet/usage` must still answer 200 with real rows when the health document
   * cannot be written.
   */
  it('should still serve quota when the health store cannot be written', async () => {
    // Arrange — a health service whose store refuses every write, which is what a full disk or a
    // permission change looks like from here.
    const subject = await fixture({
      accountHealth: new FleetAccountHealthService({
        store: {
          read: async () => [],
          write: async () => {
            throw new Error('the disk is full');
          },
        },
        credentials: { classify: async () => ({ state: 'missing' }) },
        clock: { now: () => GENERATED_AT_MS },
      }),
    });
    await writeConfig(subject);
    await subject.dispatcher.dispatch(request({ method: 'POST', path: '/v1/fleet/apply', headers: human }));

    // Act
    const response = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/usage', headers: human }));

    // Assert — quota answered, with a real row, despite health failing underneath it.
    should(response.status).equal(200);
    const usage = FleetUsageSnapshotSchema.parse(JSON.parse(response.body));
    should(usage.accounts[0]?.accountId).equal(ACCOUNT_ID);
    should(usage.at).equal(GENERATED_AT_MS);
  });

  it('should answer health from the store alone, so a read before any check is never-checked', async () => {
    // Arrange — nothing has collected yet. The route this replaced LAUNCHED every account's wrapper to
    // answer, which is why it could not be read on a page load; it is now a store read.
    const subject = await fixture();
    await writeConfig(subject);
    await subject.dispatcher.dispatch(request({ method: 'POST', path: '/v1/fleet/apply', headers: human }));

    // Act
    const response = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/health', headers: human }));

    // Assert — `null` rather than a fabricated instant. The contract this replaced required a number,
    // so a never-checked account was indistinguishable on the wire from one just checked.
    const health = FleetHealthSnapshotSchema.parse(JSON.parse(response.body));
    should(response.status).equal(200);
    should(health.accounts[0]).containEql({
      accountId: ACCOUNT_ID,
      verdict: 'unknown',
      reason: 'never_checked',
      lastCheckedAt: null,
      verdictAt: null,
    });
    // Nothing was written, because reading is not checking.
    should(await fileExists(join(subject.paths.fleet, 'account-health.json'))).be.false();
  });

  it('should persist a verdict under this daemon home when the check is asked for', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    await subject.dispatcher.dispatch(request({ method: 'POST', path: '/v1/fleet/apply', headers: human }));

    // Act — the explicit "check now". It collects the free usage read and answers from the store.
    const response = await subject.dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/fleet/health/check', headers: human }),
    );

    // Assert — a real verdict, dated, and stored inside this daemon's own home so one daemon can
    // never publish another's.
    const health = FleetHealthSnapshotSchema.parse(JSON.parse(response.body));
    should(response.status).equal(200);
    should(health.accounts[0]?.verdict).equal('needs_relogin');
    should(health.accounts[0]?.lastCheckedAt).equal(GENERATED_AT_MS);
    const document = join(subject.paths.fleet, 'account-health.json');
    should(document.startsWith(subject.root)).be.true();
    should(await fileExists(document)).be.true();
    // No credential material, no header, no provider body: codes and instants only.
    should(await readFile(document, 'utf8')).not.match(/token|Authorization|Bearer/iu);
  });

  it('should keep serving a stored verdict after the process that recorded it is gone', async () => {
    // Arrange — record a verdict, then build a WHOLLY NEW subsystem over the same state home, which
    // is exactly what a daemon restart is.
    const first = await fixture();
    await writeConfig(first);
    await first.dispatcher.dispatch(request({ method: 'POST', path: '/v1/fleet/apply', headers: human }));
    await first.dispatcher.dispatch(request({ method: 'POST', path: '/v1/fleet/health/check', headers: human }));

    // Act
    const restarted = new ApiDispatcher(
      new ApiRouter(
        fleetRoutes(
          createDaemonFleetSubsystem({
            paths: first.paths,
            userHome: first.userHome,
            clock: { now: () => GENERATED_AT_MS + 1_000 },
            files: new StateFileSystem(first.paths),
            platform: 'linux',
            mintId: () => 'proposal00000000000001',
            mintUuid: () => '00000000-0000-4000-8000-000000000002',
            confirmChange: async () => ({ kind: 'confirmed' }),
            rootPinner: new ProcfsSessionRootPinner(),
            clientName: 'fy',
            harnesses: harnessDiscoveryReader(),
          }),
        ),
      ),
      { ...CREDENTIALS, devices: { identify: () => undefined } },
      GRANTED,
    );
    const response = await restarted.dispatch(request({ path: '/v1/fleet/health', headers: human }));

    // Assert — the verdict survives, still dated by the check that produced it rather than restamped
    // by the restart. A restart is not a check.
    const health = FleetHealthSnapshotSchema.parse(JSON.parse(response.body));
    should(health.accounts[0]?.verdict).equal('needs_relogin');
    should(health.accounts[0]?.lastCheckedAt).equal(GENERATED_AT_MS);
    should(health.at).equal(GENERATED_AT_MS + 1_000);
  });
});

/**
 * A fleet whose profiles are worth asking about: one that authenticates and one that does not.
 *
 * `PLAIN_KEY` is a credential typed into a plain value, which is a real configuration somebody writes
 * once and regrets. It is here so a test can assert this route never carries it back.
 */
const profilesYaml = `
profiles:
  base:
    env:
      ANTHROPIC_BASE_URL: https://base.invalid
  work:
    env:
      ANTHROPIC_API_KEY: \${secret:WORK_KEY}
  gateway:
    env:
      PLAIN_KEY: sk-fixture-typed-into-the-wrong-box
agents:
  - name: work
    kind: claude
    profiles: [work]
    routes:
      default:
        id: ${ACCOUNT_ID}
        wrapper: fy-claude-work
        home: claude-work
        defaultModel: opus
        models: [opus]
`;

/**
 * A guard for a caller the operator has narrowed on the `use` axis — no fleet read at all.
 *
 * `NARROWED` above refuses `configure` only, so it cannot tell an ungated read from a governed one.
 */
const FLEET_READ_REFUSED: CapabilityGuard = {
  decide: demand =>
    demand.capability === 'fleet' ? { allowed: false, refusal: 'not-granted' } : { allowed: true, refusal: 'granted' },
  governance: () => ({
    governed: true,
    passwordSet: true,
    confirmChange: true,
    decide: demand =>
      demand.capability === 'fleet'
        ? { allowed: false, refusal: 'not-granted' }
        : { allowed: true, refusal: 'granted' },
  }),
  explain: () => 'this device may not read the fleet on this machine',
};

describe('the profiles a browser may read', () => {
  it('should answer the catalog the fleet package derives, in names and shapes only', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject, profilesYaml);

    // Act
    const response = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/profiles', headers: human }));

    // Assert — a whole-object comparison of the wire answer, because a value would arrive as a NEW
    // FIELD and only this shape of assertion fails when one shows up. `base` applies to every account,
    // `work` authenticates Claude and is composed by the one login, `gateway` authenticates nothing.
    should(response.status).equal(200);
    should(JSON.parse(response.body)).deepEqual({
      profiles: [
        {
          name: 'base',
          appliesToEveryAccount: true,
          variables: [{ variable: 'ANTHROPIC_BASE_URL', shape: { shape: 'literal' } }],
          accounts: ['fy-claude-work'],
          authenticates: [],
        },
        {
          name: 'gateway',
          appliesToEveryAccount: false,
          variables: [{ variable: 'PLAIN_KEY', shape: { shape: 'literal' } }],
          accounts: [],
          authenticates: [],
        },
        {
          name: 'work',
          appliesToEveryAccount: false,
          variables: [{ variable: 'ANTHROPIC_API_KEY', shape: { shape: 'secret', secrets: ['WORK_KEY'] } }],
          accounts: ['fy-claude-work'],
          authenticates: ['claude'],
        },
      ],
      credentialVariables: {
        claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
        codex: ['OPENAI_API_KEY'],
      },
    });
  });

  it('should carry no value, not even the literal one this host can read out of its own config', async () => {
    // Arrange — the host CAN read `PLAIN_KEY`, so nothing but the shape of this projection stops it
    // travelling. `docs/secrets.md` is the contract and the daemon has no route that answers a value.
    const subject = await fixture();
    await writeConfig(subject, profilesYaml);

    // Act
    const response = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/profiles', headers: human }));

    // Assert
    should(response.body.includes('sk-fixture-typed-into-the-wrong-box')).be.false();
    should(response.body.includes('https://base.invalid')).be.false();
  });

  it('should refuse a caller the operator has not allowed to read the fleet', async () => {
    // Arrange — the same capability as every other fleet read, on the `use` axis. It discloses
    // strictly less than `/config` beside it, so a caller allowed to read one cannot learn a
    // credential by reading either — but "less" is not "ungated", which is what this asserts.
    const subject = await fixture({ guard: FLEET_READ_REFUSED });
    await writeConfig(subject, profilesYaml);

    // Act
    const response = await subject.dispatcher.dispatch(
      request({ path: '/v1/fleet/profiles', headers: { authorization: 'Bearer paired-device' } }),
    );

    // Assert
    should(response.status).equal(403);
  });

  it('should refuse a caller with no credential at all, rather than being open because it is a read', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject, profilesYaml);

    // Act
    const response = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/profiles' }));

    // Assert
    should(response.status).equal(401);
  });

  it('should refuse a damaged config rather than answering an empty catalog', async () => {
    // Arrange — an empty list is what an ordinary fleet with no profiles looks like, so answering one
    // for a config nobody can parse would tell a browser this fleet declares nothing.
    const subject = await fixture();
    await writeConfig(subject, 'agents: definitely-not-a-list\n');

    // Act
    const response = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/profiles', headers: human }));

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'fleet_config_invalid');
  });
});
