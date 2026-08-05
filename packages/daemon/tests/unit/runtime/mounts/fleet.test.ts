import { afterEach, describe, it } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FleetApplyPlan, FleetConfigSchema, FleetManifestSchema, FleetUsageSnapshotSchema } from '@ferretry/fleet';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { createFoundationPaths } from '../../../../src/lib/paths.ts';
import { createDaemonFleetSubsystem, fleetRoutes } from '../../../../src/lib/runtime/mounts/fleet.ts';
import { resolveStateHome } from '../../../../src/lib/state-home.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, human } from './support.ts';

const GENERATED_AT_MS = Date.parse('2027-01-15T08:00:00.000Z');
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const temporaryDirectories: string[] = [];

interface FleetFixture {
  readonly root: string;
  readonly userHome: string;
  readonly paths: ReturnType<typeof createFoundationPaths>;
  readonly dispatcher: ApiDispatcher;
}

async function fixture(): Promise<FleetFixture> {
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
    platform: 'linux',
  });
  const credentials = {
    ...CREDENTIALS,
    devices: { identify: (token: string) => (token === 'paired-device' ? 'device-1' : undefined) },
  };
  return { root, userHome, paths, dispatcher: new ApiDispatcher(new ApiRouter(fleetRoutes(subsystem)), credentials) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const configYaml = `
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
  it('should require operator authority and never let a paired device provision', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);
    const device = { authorization: 'Bearer paired-device', 'x-ferretry-client': 'ui' } as const;
    const warden = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

    // Act
    const anonymous = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/plan' }));
    const scoped = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/plan', headers: warden }));
    const deviceRead = await subject.dispatcher.dispatch(request({ path: '/v1/fleet/plan', headers: device }));
    const deviceApply = await subject.dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/fleet/apply', headers: device }),
    );

    // Assert
    should(anonymous.status).equal(401);
    should(scoped.status).equal(403);
    should(deviceRead.status).equal(200);
    should(deviceApply.status).equal(403);
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
    should(wrapper.startsWith(subject.root)).be.true();
    should(subject.paths.fleetManifest.startsWith(subject.root)).be.true();
  });
});
