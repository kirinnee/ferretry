/**
 * The first run and Clone over real files, end to end: the host scan, the import, the real
 * provisioner's apply, the catalogue reading back what was written, then the export of that machine
 * copied onto a second one.
 *
 * Every path is inside a directory this test created, the person's "own" home is a temporary one, and
 * every credential is a placeholder, so no real harness setup, login or fleet is read or written.
 */
import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAccountModel } from '@ferretry/fleet';
import { FleetCloneBundleSchema } from '@ferretry/protocol';
import should from 'should';
import { fileFleetCatalogDeps } from '../../../src/adapters/fleet/account-model-files.ts';
import { fileFleetSetupDeps } from '../../../src/adapters/fleet/setup-files.ts';
import { FleetCatalogService } from '../../../src/lib/fleet/catalog-service.ts';
import { createFleetSetupSubsystem, type FleetSetupService } from '../../../src/lib/fleet/setup-service.ts';

const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fy-setup-journey-')));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async directory => await rm(directory, { recursive: true, force: true })),
  );
});

/** A placeholder Claude login: shaped like one, worth nothing. */
const FAKE_LOGIN = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'placeholder-access',
    refreshToken: 'placeholder-refresh',
    expiresAt: 4_102_444_800_000,
  },
});
const FAKE_SECRET = 'ghp_placeholderplaceholderplaceholder0000';

interface Machine {
  readonly fleet: string;
  readonly userHome: string;
  readonly setup: FleetSetupService;
  readonly catalog: FleetCatalogService;
  readonly secrets: Map<string, string>;
}

async function machine(name: string, options: { readonly claude: boolean }): Promise<Machine> {
  const root = await temporary();
  const home = path.join(root, 'state');
  const fleet = path.join(home, 'fleet');
  const userHome = path.join(root, 'person');
  await mkdir(fleet, { recursive: true });
  await mkdir(userHome, { recursive: true });
  if (options.claude) {
    const claude = path.join(userHome, '.claude');
    await mkdir(path.join(claude, 'skills', 'review'), { recursive: true });
    await writeFile(path.join(claude, 'CLAUDE.md'), 'Be kind.\n');
    await writeFile(path.join(claude, 'settings.json'), JSON.stringify({ env: { GITHUB_TOKEN: FAKE_SECRET } }));
    await writeFile(path.join(claude, 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\nReview it.\n');
    await writeFile(path.join(claude, '.credentials.json'), FAKE_LOGIN, { mode: 0o600 });
  }
  const secrets = new Map<string, string>();
  const credentials = {
    list: async () => ({ format: 2 as const, machine: name, credentials: [] }),
    signOut: async () => {
      throw new Error('not exercised');
    },
  };
  const catalogDeps = fileFleetCatalogDeps({
    paths: { home: home as never, fleet, fleetManifest: path.join(fleet, 'manifest.json') },
    userHome,
    sessionStates: async () => [],
    credentials,
    confirmChange: async () => ({ kind: 'confirmed' }),
    locate: harness => (harness === 'claude' && options.claude ? '/bin/sh' : undefined),
    machineName: () => name,
    clientName: 'fy',
  });
  const setup = createFleetSetupSubsystem(
    fileFleetSetupDeps({
      catalog: catalogDeps,
      credentials: {
        material: async () => ({ outcome: 'missing' }),
        storedMaterial: async () => (options.claude ? { outcome: 'found', blob: FAKE_LOGIN } : { outcome: 'missing' }),
      } as never,
      tools: { plans: () => [], install: async () => [] },
      secrets: {
        list: async () => [...secrets.keys()].map(secret => ({ name: secret })),
        put: async (secret, value) => {
          secrets.set(secret, value);
        },
      },
    }),
  );
  const catalog = new FleetCatalogService({ ...catalogDeps, executors: setup.executors });
  return { fleet, userHome, setup, catalog, secrets };
}

/** The import a person chooses, staged and applied through the catalogue the way the app and `fy daemon import` do it. */
async function importHost(on: Awaited<ReturnType<typeof machine>>): Promise<unknown> {
  const staged = await on.catalog.propose({ kind: 'setup.import' });
  return await on.catalog.apply(staged.id, {}, { governed: false, passwordSet: false, confirmChange: false } as never);
}

/** Every file under a directory, relative to it. */
async function filesUnder(root: string, relative = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(root, next)));
    else if (entry.isFile()) found.push(next);
  }
  return found;
}

describe('the first run and Clone over real files', () => {
  it('should import the host setup when asked, sharing the login in place and copying no credential', async () => {
    // Arrange
    const studio = await machine('studio', { claude: true });

    // Act
    const result = await importHost(studio);

    // Assert: a version-2 configuration whose login is the host's own, and a runtime that launches as an agent.
    should(result).deepEqual({
      outcome: 'executed',
      executor: 'setup',
      summary: 'studio is ready · 1 runtime created: claude-default.',
    });
    const model = parseAccountModel(Bun.YAML.parse(await readFile(path.join(studio.fleet, 'config.yaml'), 'utf8')));
    should(model.credentials['claude-you']).deepEqual({ harness: 'claude', store: 'host' });
    should(model.runtimes['claude-default']).deepEqual({ credential: 'claude-you', profile: 'default', agent: true });
    should(await lstat(path.join(studio.fleet, 'bin', 'claude-default'))).be.ok();
    should(await lstat(path.join(studio.fleet, 'assets', 'skills', 'review', 'SKILL.md'))).be.ok();

    // The secret went to the store and nowhere else; no credential file was copied into the fleet.
    should(studio.secrets.get('GITHUB_TOKEN')).equal(FAKE_SECRET);
    for (const file of await filesUnder(studio.fleet)) {
      should(path.basename(file)).not.equal('.credentials.json');
      should(await readFile(path.join(studio.fleet, file), 'utf8')).not.containEql(FAKE_SECRET);
    }

    // The catalogue reads back exactly what the import wrote.
    const runtimes = await studio.catalog.runtimes();
    should(runtimes.runtimes.map(runtime => runtime.name)).deepEqual(['claude-default']);
  });

  it('should copy one machine onto another as a reviewed change, each login an empty slot', async () => {
    // Arrange: a set-up source and a bare target.
    const studio = await machine('studio', { claude: true });
    await importHost(studio);
    const bundle = FleetCloneBundleSchema.parse(await studio.setup.exportBundle());
    const target = await machine('work-linux', { claude: false });

    // Act: staged and applied through the catalogue, as the browser does it.
    const staged = await target.catalog.propose({ kind: 'clone.import', mode: 'alongside', bundle });
    const outcome = await target.catalog.apply(staged.id, {}, {
      governed: false,
      passwordSet: false,
      confirmChange: false,
    } as never);

    // Assert
    should(staged.preview).match({ kind: 'executor', executor: 'clone' });
    should(outcome).deepEqual({
      outcome: 'executed',
      executor: 'clone',
      summary: 'Copied 1 runtime from studio. Sign in once for 1 runtime: claude-you.',
    });
    const model = parseAccountModel(Bun.YAML.parse(await readFile(path.join(target.fleet, 'config.yaml'), 'utf8')));
    should(model.credentials['claude-you']).deepEqual({ harness: 'claude', store: 'ferretry', clonedFrom: 'studio' });
    should(Object.keys(model.runtimes)).deepEqual(['claude-default']);
    should(await readFile(path.join(target.fleet, 'assets', 'skills', 'review', 'SKILL.md'), 'utf8')).containEql(
      'Review it.',
    );
    // History is not copied, and neither is any login.
    should(await filesUnder(path.join(target.fleet))).not.containEql('credentials/claude-you/.credentials.json');
  });
});
