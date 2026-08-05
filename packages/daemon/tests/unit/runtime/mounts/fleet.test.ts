import { afterEach, describe, it } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FleetApplyPlan, FleetConfigSchema, FleetManifestSchema, FleetUsageSnapshotSchema } from '@ferretry/fleet';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { StateFileSystem } from '../../../../src/adapters/filesystem/state-file-system.ts';
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
  const subsystem = createDaemonFleetSubsystem({
    paths,
    userHome,
    clock: { now: () => GENERATED_AT_MS },
    files: new StateFileSystem(paths),
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

  it('should require a host-admin credential before changing profile environment', async () => {
    // Arrange
    const subject = await fixture();
    await writeConfig(subject);

    // Act
    const response = await subject.dispatcher.dispatch(
      request({
        method: 'PUT',
        path: '/v1/fleet/environment',
        headers: { authorization: 'Bearer paired-device', 'x-ferretry-client': 'ui' },
        body: JSON.stringify({ profile: 'portable', mode: 'replace', environment: {} }),
      }),
    );

    // Assert
    should(response.status).equal(403);
  });

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
    should(usage.accounts[0]).containEql({
      accountId: ACCOUNT_ID,
      unavailable: true,
      unavailableReason: 'no provider quota probe is provisioned on this daemon',
      atLimit: true,
    });
    should(wrapper.startsWith(subject.root)).be.true();
    should(subject.paths.fleetManifest.startsWith(subject.root)).be.true();
  });
});
