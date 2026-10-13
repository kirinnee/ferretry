/**
 * The migration executor against a real filesystem and a scripted `security`
 * (docs/design/account-model.md §10.2, §10.3).
 *
 * Every path is inside a temporary directory this test created, every credential is a placeholder, and
 * nothing here launches a harness. The person's "own" logins are files under a temporary HOME, and the
 * test proves the migration reads them and never writes them.
 */
import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { credentialFingerprint } from '../../src/adapters/credential-classifier.ts';
import {
  type CredentialCommand,
  type CredentialCommandResult,
  DEFAULT_KEYCHAIN_SERVICE,
  KEYCHAIN_ITEM_NOT_FOUND,
  keychainService,
  PlatformFleetCredentialStore,
  secureStorageKeychainService,
} from '../../src/adapters/credential-store.ts';
import {
  FleetMigration,
  type FleetMigrationDeps,
  type MigrationApplyPort,
  renderConfig,
} from '../../src/adapters/migration-executor.ts';
import { FileSeedProvenanceStore, seedProvenancePath } from '../../src/adapters/seed-provenance-store.ts';
import type { AccountModel } from '../../src/lib/account/schema.ts';
import type { FleetLayout } from '../../src/lib/provisioning.ts';
import { buildFleetScaffold, fleetScaffoldIds } from '../../src/lib/scaffold.ts';
import type { FleetSeedProvenanceRecord } from '../../src/lib/seed-provenance.ts';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WRAPPERS = ['claude-default', 'claude-auto-default', 'codex-default', 'codex-auto-default'] as const;

const temporaryDirectories: string[] = [];

async function temporaryDirectory(parent = tmpdir()): Promise<string> {
  const directory = await mkdtemp(path.join(parent, 'fy-fleet-migration-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const claudeBlob = (token: string, expiresAt: number): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: `access-${token}`, refreshToken: `refresh-${token}`, expiresAt } });

const jwt = (exp: number): string =>
  `x.${Buffer.from(JSON.stringify({ exp: Math.trunc(exp / 1000) })).toString('base64url')}.y`;

const codexBlob = (token: string, lastRefresh: number): string =>
  JSON.stringify({
    tokens: { access_token: jwt(NOW + HOUR), refresh_token: `refresh-${token}` },
    last_refresh: new Date(lastRefresh).toISOString(),
  });

const exists = async (target: string): Promise<boolean> =>
  lstat(target).then(
    () => true,
    () => false,
  );

/** A scripted `security`: an in-memory keychain of service → blob, plus failures by command word. */
class FakeKeychain implements CredentialCommand {
  readonly items = new Map<string, string>();
  readonly calls: string[][] = [];
  failWith: Partial<Record<'find' | 'write' | 'delete' | 'list', number>> = {};

  async run(command: readonly [string, ...string[]], _timeoutMs: number, stdin?: string): Promise<CredentialCommandResult> {
    this.calls.push([...command]);
    const [, verb, ...rest] = command;
    if (verb === '-i') {
      if (this.failWith.write !== undefined) return { code: this.failWith.write, stdout: '' };
      const match = /-s "([^"]+)" -X ([0-9a-f]+)/u.exec(stdin ?? '');
      if (match === null) return { code: 1, stdout: '' };
      this.items.set(match[1] as string, Buffer.from(match[2] as string, 'hex').toString('utf8'));
      return { code: 0, stdout: '' };
    }
    const service = rest[rest.indexOf('-s') + 1] as string;
    if (verb === 'delete-generic-password') {
      if (this.failWith.delete !== undefined) return { code: this.failWith.delete, stdout: '' };
      return this.items.delete(service) ? { code: 0, stdout: '' } : { code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' };
    }
    const value = this.items.get(service);
    if (rest.includes('-w')) {
      if (this.failWith.find !== undefined) return { code: this.failWith.find, stdout: '' };
      return value === undefined ? { code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' } : { code: 0, stdout: `${value}\n` };
    }
    if (this.failWith.list !== undefined) return { code: this.failWith.list, stdout: '' };
    return value === undefined
      ? { code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' }
      : { code: 0, stdout: 'attributes:\n    "acct"<blob>="someone"\n' };
  }
}

interface Machine {
  readonly root: string;
  readonly userHome: string;
  readonly layout: FleetLayout;
  readonly configPath: string;
  readonly configText: string;
  readonly homes: Record<(typeof WRAPPERS)[number], string>;
  readonly applied: AccountModel[];
  readonly keychain: FakeKeychain;
  live: { session: string; accountId: string }[];
  applyFails?: string;
  migration(overrides?: Partial<FleetMigrationDeps>): FleetMigration;
}

/** Today's default first run on disk: four homes, four copies, the host's own logins under HOME. */
async function firstRunMachine(
  options: { platform?: string; homesParent?: string; provenance?: boolean; hostLogins?: boolean } = {},
): Promise<Machine> {
  const root = await temporaryDirectory();
  const userHome = path.join(root, 'home');
  const fleetDirectory = path.join(root, 'fy', 'fleet');
  const homesDirectory = options.homesParent ?? path.join(fleetDirectory, 'homes');
  const layout: FleetLayout = {
    stateHome: path.join(root, 'fy'),
    userHome,
    fleetDirectory,
    binDirectory: path.join(fleetDirectory, 'bin'),
    homesDirectory,
    assetsDirectory: path.join(fleetDirectory, 'assets'),
    manifestPath: path.join(fleetDirectory, 'manifest.json'),
    defaultHomeDirectories: { claude: path.join(userHome, '.claude'), codex: path.join(userHome, '.codex') },
  };
  let next = 0;
  const scaffold = buildFleetScaffold({
    layout,
    ids: fleetScaffoldIds(() => id(next++)),
    configPath: path.join(fleetDirectory, 'config.yaml'),
    firstAccounts: ['claude', 'codex'],
  });
  const configText = scaffold.files[0]?.content ?? '';
  const configPath = path.join(fleetDirectory, 'config.yaml');
  await mkdir(fleetDirectory, { recursive: true });
  await writeFile(configPath, configText);
  await writeFile(layout.manifestPath, '{"version":1}\n');

  const platform = options.platform ?? 'linux';
  const keychain = new FakeKeychain();
  const homes = Object.fromEntries(WRAPPERS.map(wrapper => [wrapper, path.join(homesDirectory, wrapper)])) as Machine['homes'];
  const records: FleetSeedProvenanceRecord[] = [];
  for (const [index, wrapper] of WRAPPERS.entries()) {
    const home = homes[wrapper];
    await mkdir(home, { recursive: true });
    const claude = wrapper.startsWith('claude');
    const blob = claude ? claudeBlob('host', NOW + HOUR) : codexBlob('host', NOW - HOUR);
    if (claude && platform === 'darwin') keychain.items.set(keychainService(home), blob);
    else await writeFile(path.join(home, claude ? '.credentials.json' : 'auth.json'), blob, { mode: 0o600 });
    records.push({
      accountId: id(index),
      kind: claude ? 'claude' : 'codex',
      seededFrom: `host:${claude ? 'claude' : 'codex'}`,
      donorHome: path.join(userHome, claude ? '.claude' : '.codex'),
      seedFingerprint: credentialFingerprint(blob),
      seededAt: 1,
    });
  }
  if (options.hostLogins !== false) {
    await mkdir(path.join(userHome, '.claude'), { recursive: true });
    await mkdir(path.join(userHome, '.codex'), { recursive: true });
    if (platform === 'darwin') keychain.items.set(DEFAULT_KEYCHAIN_SERVICE, claudeBlob('host', NOW + HOUR));
    else await writeFile(path.join(userHome, '.claude', '.credentials.json'), claudeBlob('host', NOW + HOUR));
    await writeFile(path.join(userHome, '.codex', 'auth.json'), codexBlob('host', NOW - HOUR));
  }
  const provenance = new FileSeedProvenanceStore(seedProvenancePath(fleetDirectory));
  if (options.provenance !== false) await provenance.write(records);

  const machine: Machine = {
    root,
    userHome,
    layout,
    configPath,
    configText,
    homes,
    applied: [],
    keychain,
    live: [],
    migration(overrides = {}) {
      const apply: MigrationApplyPort = {
        apply: async model => {
          if (machine.applyFails !== undefined) throw new Error(machine.applyFails);
          machine.applied.push(model);
        },
      };
      return new FleetMigration({
        layout,
        configPath,
        platform,
        credentials: new PlatformFleetCredentialStore({ platform, command: keychain, now: () => NOW, keychainAccount: 'someone' }),
        command: keychain,
        keychainAccount: 'someone',
        hostCodexHome: path.join(userHome, '.codex'),
        provenance,
        sessions: { live: async () => machine.live },
        apply,
        now: () => NOW,
        ...overrides,
      });
    },
  };
  return machine;
}

/** Give the four homes different copies, so the store cannot be the host's (no provenance proves it). */
async function divergeCopies(machine: Machine): Promise<void> {
  await writeFile(path.join(machine.homes['claude-default'], '.credentials.json'), claudeBlob('old', NOW + HOUR));
  await writeFile(path.join(machine.homes['claude-auto-default'], '.credentials.json'), claudeBlob('new', NOW + 9 * HOUR));
  await writeFile(path.join(machine.homes['codex-default'], 'auth.json'), codexBlob('alive', NOW - 60_000));
  await writeFile(path.join(machine.homes['codex-auto-default'], 'auth.json'), codexBlob('spent', NOW - 9 * HOUR));
}

async function dryRunAndMigrate(machine: Machine, migration = machine.migration()) {
  const dryRun = await migration.dryRun();
  return { dryRun, outcome: await migration.migrate(dryRun.plan.digest) };
}

describe('FleetMigration — the default first run, shared with the terminal', () => {
  it('should migrate to version 2, retiring every copy and leaving your own logins byte for byte', async () => {
    // Arrange
    const machine = await firstRunMachine();
    const ownClaude = await readFile(path.join(machine.userHome, '.claude', '.credentials.json'), 'utf8');
    const ownCodex = await readFile(path.join(machine.userHome, '.codex', 'auth.json'), 'utf8');

    // Act
    const { dryRun, outcome } = await dryRunAndMigrate(machine);

    // Assert
    should(outcome.kind).equal('migrated');
    should(dryRun.lines).containEql('  claude-default (claude, shared with your terminal)');
    should(await readFile(`${machine.configPath}.v1`, 'utf8')).equal(machine.configText);
    should(await readFile(machine.configPath, 'utf8')).equal(dryRun.configText);
    should(await readFile(path.join(machine.userHome, '.claude', '.credentials.json'), 'utf8')).equal(ownClaude);
    should(await readFile(path.join(machine.userHome, '.codex', 'auth.json'), 'utf8')).equal(ownCodex);
    for (const wrapper of ['claude-default', 'claude-auto-default'] as const) {
      should(await exists(path.join(machine.homes[wrapper], '.credentials.json'))).be.false();
    }
    for (const wrapper of ['codex-default', 'codex-auto-default'] as const) {
      should(await readlink(path.join(machine.homes[wrapper], 'auth.json'))).equal(path.join(machine.userHome, '.codex', 'auth.json'));
    }
    should(machine.applied.map(model => Object.keys(model.runtimes).toSorted())).deepEqual([
      ['claude-auto-default', 'claude-default', 'codex-auto-default', 'codex-default'],
    ]);
    const ids = JSON.parse(await readFile(path.join(machine.layout.fleetDirectory, 'ids.json'), 'utf8'));
    should(ids.runtimes['codex-auto-default']).deepEqual({ id: id(3), formerNames: [], home: 'codex-auto-default' });
    if (outcome.kind !== 'migrated') throw new Error('unreachable');
    should(outcome.resumed).be.false();
    const retired = await readdir(path.join(outcome.report.retired, 'copies'));
    should(retired.toSorted()).deepEqual([id(0), id(1), id(2), id(3)].toSorted());
    should(await exists(seedProvenancePath(machine.layout.fleetDirectory))).be.false();
    should(await exists(path.join(outcome.report.retired, 'documents', 'seed-provenance.json.retired'))).be.true();
    should(await exists(path.join(outcome.report.retired, 'documents', 'manifest.json'))).be.true();
    should(outcome.report.credentials.find(credential => credential.id === 'codex-default')?.kept).equal(
      `your own login in ${path.join(machine.userHome, '.codex')}`,
    );
    const report = JSON.parse(await readFile(path.join(machine.layout.fleetDirectory, 'migration', 'report.json'), 'utf8'));
    should(report.digest).equal(dryRun.plan.digest);
    should(await exists(path.join(machine.layout.fleetDirectory, 'migration', 'state.json'))).be.false();
  });

  it('should be safe to run again: it says the machine is already on the new format', async () => {
    // Arrange
    const machine = await firstRunMachine();
    await dryRunAndMigrate(machine);

    // Act
    const status = await machine.migration().status();
    const again = machine.migration().dryRun();

    // Assert
    should(status).deepEqual({ kind: 'version-2' });
    await should(again).be.rejectedWith('this machine already uses the new account format');
  });
});

describe('FleetMigration — keeping the freshest copy in Ferretry', () => {
  it('should move the freshest copy into the store, read it back, and only then retire the others', async () => {
    // Arrange
    const machine = await firstRunMachine({ provenance: false });
    await divergeCopies(machine);
    const freshest = await readFile(path.join(machine.homes['claude-auto-default'], '.credentials.json'), 'utf8');
    const alive = await readFile(path.join(machine.homes['codex-default'], 'auth.json'), 'utf8');

    // Act
    const { outcome } = await dryRunAndMigrate(machine);

    // Assert
    should(outcome.kind).equal('migrated');
    const store = path.join(machine.layout.fleetDirectory, 'credentials');
    should(await readFile(path.join(store, 'claude-default', '.credentials.json'), 'utf8')).equal(freshest);
    should(await readFile(path.join(store, 'codex-default', 'auth.json'), 'utf8')).equal(alive);
    should((await lstat(path.join(store, 'codex-default', 'auth.json'))).mode & 0o777).equal(0o600);
    should(await readlink(path.join(machine.homes['codex-auto-default'], 'auth.json'))).equal(
      path.join(store, 'codex-default', 'auth.json'),
    );
    if (outcome.kind !== 'migrated') throw new Error('unreachable');
    should(outcome.report.credentials.find(credential => credential.id === 'claude-default')).match({
      store: 'ferretry',
      kept: `the copy from claude-auto-default (${machine.homes['claude-auto-default']})`,
    });
    should(outcome.report.credentials[0]?.retired.length).equal(2);
  });

  it('should move a copy across filesystems by copying, reading back, then removing the original', async () => {
    // Arrange — homes on another device than the fleet directory, where a rename cannot reach
    const machine = await firstRunMachine({ provenance: false, homesParent: await temporaryDirectory('/dev/shm') });
    await divergeCopies(machine);

    // Act
    const { outcome } = await dryRunAndMigrate(machine);

    // Assert
    should(outcome.kind).equal('migrated');
    should(await exists(path.join(machine.homes['claude-default'], '.credentials.json'))).be.false();
    if (outcome.kind !== 'migrated') throw new Error('unreachable');
    const moved = path.join(outcome.report.retired, 'copies', id(0), '.credentials.json');
    should(await readFile(moved, 'utf8')).equal(claudeBlob('old', NOW + HOUR));
  });
});

describe('FleetMigration — never silently', () => {
  it('should refuse an approval that is not the dry run it was shown', async () => {
    // Arrange
    const machine = await firstRunMachine();

    // Act
    const outcome = await machine.migration().migrate('not-the-digest');

    // Assert
    should(outcome.kind).equal('refused');
    should(await readFile(machine.configPath, 'utf8')).equal(machine.configText);
  });

  it('should refuse while a session runs on a login it moves', async () => {
    // Arrange
    const machine = await firstRunMachine();
    machine.live = [{ session: 'review', accountId: id(0) }];

    // Act
    const { outcome } = await dryRunAndMigrate(machine);

    // Assert
    should(outcome).deepEqual({
      kind: 'refused',
      reasons: ['login claude-default is in use by running session review; stop it and run the migration again'],
    });
  });

  it('should refuse when a session starts between the dry run and the approval', async () => {
    // Arrange
    const machine = await firstRunMachine();
    const migration = machine.migration();
    const { plan } = await migration.dryRun();
    let calls = 0;
    const racing = machine.migration({
      sessions: { live: async () => (calls++ === 0 ? [] : [{ session: 'late', accountId: id(2) }]) },
    });

    // Act
    const outcome = await racing.migrate(plan.digest);

    // Assert
    should(outcome).deepEqual({
      kind: 'refused',
      reasons: ['login codex-default is in use by running session late; stop it and run the migration again'],
    });
  });

  it('should say why there is nothing to migrate on a machine with no fleet', async () => {
    // Arrange
    const machine = await firstRunMachine();
    await rm(machine.configPath);

    // Act / Assert
    should(await machine.migration().status()).deepEqual({ kind: 'no-fleet' });
    await should(machine.migration().dryRun()).be.rejectedWith('this machine has no fleet to migrate; set it up instead');
  });
});

describe('FleetMigration — a failure puts everything back', () => {
  it('should roll back when the apply fails: copies home, links out, the store emptied, config.yaml restored', async () => {
    // Arrange
    const machine = await firstRunMachine({ provenance: false });
    await divergeCopies(machine);
    machine.applyFails = 'the wrappers could not be written';
    const before = await readFile(path.join(machine.homes['codex-auto-default'], 'auth.json'), 'utf8');

    // Act
    const { outcome } = await dryRunAndMigrate(machine);

    // Assert
    should(outcome).deepEqual({ kind: 'rolled-back', reason: 'the wrappers could not be written', unrestored: [] });
    should(await readFile(machine.configPath, 'utf8')).equal(machine.configText);
    should(await readFile(path.join(machine.homes['codex-auto-default'], 'auth.json'), 'utf8')).equal(before);
    should((await lstat(path.join(machine.homes['codex-auto-default'], 'auth.json'))).isFile()).be.true();
    should(await exists(path.join(machine.layout.fleetDirectory, 'credentials', 'codex-default', 'auth.json'))).be.false();
    should(await exists(path.join(machine.layout.fleetDirectory, 'ids.json'))).be.false();
    should(await exists(path.join(machine.layout.fleetDirectory, 'migration', 'state.json'))).be.false();
    should(await machine.migration().status()).deepEqual({ kind: 'version-1' });
  });

  it('should keep what changed after the migration wrote it, and name where each original is', async () => {
    // Arrange — the apply "fails" after a harness renewed the stored login and a copy reappeared
    const machine = await firstRunMachine({ provenance: false });
    await divergeCopies(machine);
    const storeFile = path.join(machine.layout.fleetDirectory, 'credentials', 'claude-default', '.credentials.json');
    const migration = machine.migration({
      apply: {
        apply: async () => {
          await writeFile(storeFile, claudeBlob('renewed', NOW + 20 * HOUR));
          await writeFile(path.join(machine.homes['claude-default'], '.credentials.json'), 'someone else');
          throw new Error('stop');
        },
      },
    });

    // Act
    const { outcome } = await dryRunAndMigrate(machine, migration);

    // Assert
    if (outcome.kind !== 'rolled-back') throw new Error(`expected a rollback, got ${outcome.kind}`);
    should(outcome.unrestored).containEql(`${storeFile} changed after the migration wrote it, so it was kept`);
    should(outcome.unrestored.some(line => line.startsWith(`${path.join(machine.homes['claude-default'], '.credentials.json')} was not put back`))).be.true();
    const record = (await readdir(path.join(machine.layout.fleetDirectory, 'migration'))).find(name => name.startsWith('rollback-'));
    should(record).not.be.undefined();
  });

  it('should restore an existing ids.json it replaced', async () => {
    // Arrange
    const machine = await firstRunMachine();
    const idsPath = path.join(machine.layout.fleetDirectory, 'ids.json');
    await writeFile(idsPath, '{"version":1,"runtimes":{}}\n');
    machine.applyFails = 'no';

    // Act
    await dryRunAndMigrate(machine);

    // Assert
    should(await readFile(idsPath, 'utf8')).equal('{"version":1,"runtimes":{}}\n');
  });

  it('should refuse to write over a store that already holds another login, and roll back', async () => {
    // Arrange
    const machine = await firstRunMachine({ provenance: false });
    await divergeCopies(machine);
    await mkdir(path.join(machine.layout.fleetDirectory, 'credentials', 'claude-default'), { recursive: true });
    await writeFile(path.join(machine.layout.fleetDirectory, 'credentials', 'claude-default', '.credentials.json'), claudeBlob('stranger', NOW));

    // Act
    const { outcome } = await dryRunAndMigrate(machine);

    // Assert
    should(outcome).match({
      kind: 'rolled-back',
      reason: "Ferretry's store for login claude-default already holds a different login, so nothing was written over it",
    });
  });

  it('should refuse a copy that changed after the dry run', async () => {
    // Arrange
    const machine = await firstRunMachine({ provenance: false });
    await divergeCopies(machine);
    const migration = machine.migration();
    const { plan } = await migration.dryRun();
    const credentials = new PlatformFleetCredentialStore({ platform: 'linux', command: machine.keychain, now: () => NOW, keychainAccount: 'x' });
    let reads = 0;
    const changing = machine.migration({
      credentials: {
        storedMaterial: resolution => credentials.storedMaterial(resolution),
        material: async (kind, home) => {
          // The survey reads each home once; the store step re-reads the kept copy, which has changed.
          reads++;
          return reads > 4 ? { outcome: 'found', blob: claudeBlob('changed', NOW + HOUR) } : credentials.material(kind, home);
        },
      },
    });

    // Act
    const outcome = await changing.migrate(plan.digest);

    // Assert
    should(outcome).match({
      kind: 'rolled-back',
      reason: `the copy of login claude-default in ${machine.homes['claude-auto-default']} changed after the dry run; run the dry run again`,
    });
  });

  it('should roll back when the new store cannot be read back', async () => {
    // Arrange
    const machine = await firstRunMachine({ provenance: false });
    await divergeCopies(machine);
    const credentials = new PlatformFleetCredentialStore({ platform: 'linux', command: machine.keychain, now: () => NOW, keychainAccount: 'x' });
    let stored = 0;
    const migration = machine.migration({
      credentials: {
        material: (kind, home) => credentials.material(kind, home),
        storedMaterial: async resolution => {
          stored++;
          // Survey reads two host logins; the store step reads once; the verify read fails.
          if (stored === 4) throw new Error('disk gone');
          return credentials.storedMaterial(resolution);
        },
      },
    });

    // Act
    const { outcome } = await dryRunAndMigrate(machine, migration);

    // Assert
    should(outcome).match({
      kind: 'rolled-back',
      reason: 'login claude-default could not be read back from its new store (unreadable), so no copy was retired',
    });
    should(await exists(path.join(machine.homes['claude-default'], '.credentials.json'))).be.true();
  });

  it('should roll back when the store reads back a different login', async () => {
    // Arrange
    const machine = await firstRunMachine({ provenance: false });
    await divergeCopies(machine);
    const credentials = new PlatformFleetCredentialStore({ platform: 'linux', command: machine.keychain, now: () => NOW, keychainAccount: 'x' });
    let stored = 0;
    const migration = machine.migration({
      credentials: {
        material: (kind, home) => credentials.material(kind, home),
        storedMaterial: async resolution => {
          stored++;
          if (stored === 4) return { outcome: 'found', blob: claudeBlob('other', NOW + HOUR) };
          return credentials.storedMaterial(resolution);
        },
      },
    });

    // Act
    const { outcome } = await dryRunAndMigrate(machine, migration);

    // Assert
    should(outcome).match({
      kind: 'rolled-back',
      reason: 'login claude-default read back from its new store is not the copy that was moved, so no copy was retired',
    });
  });

  it('should refuse a generated settings file that would replace one of yours', async () => {
    // Arrange — a version-1 inline settings object becomes a file the migration writes
    const machine = await firstRunMachine();
    const config = Bun.YAML.parse(machine.configText) as { agents: { routes: Record<string, Record<string, unknown>> }[] };
    const first = config.agents[0]?.routes.default as Record<string, unknown>;
    first.layer = { settings: [{ theme: 'dark' }] };
    await writeFile(machine.configPath, Bun.YAML.stringify(config));
    const migration = machine.migration();
    const { plan } = await migration.dryRun();
    const body = plan.settingsBodies[0];
    if (body === undefined) throw new Error('expected a generated settings body');
    const file = path.join(machine.layout.assetsDirectory, body.file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"mine": true}\n');

    // Act
    const outcome = await migration.migrate(plan.digest);

    // Assert
    should(outcome).match({ kind: 'rolled-back', reason: `${file} already exists with other content, so it was left as it is` });
    should(await readFile(file, 'utf8')).equal('{"mine": true}\n');
  });

  it('should write a generated settings file, and leave one that already says the same', async () => {
    // Arrange
    const machine = await firstRunMachine();
    const config = Bun.YAML.parse(machine.configText) as { agents: { routes: Record<string, Record<string, unknown>> }[] };
    (config.agents[0]?.routes.default as Record<string, unknown>).layer = { settings: [{ theme: 'dark' }] };
    (config.agents[0]?.routes.auto as Record<string, unknown>).layer = { settings: [{ theme: 'light' }] };
    await writeFile(machine.configPath, Bun.YAML.stringify(config));
    const migration = machine.migration();
    const { plan } = await migration.dryRun();
    const [kept, written] = plan.settingsBodies;
    if (kept === undefined || written === undefined) throw new Error('expected two generated settings bodies');
    const keptFile = path.join(machine.layout.assetsDirectory, kept.file);
    await mkdir(path.dirname(keptFile), { recursive: true });
    await writeFile(keptFile, `${JSON.stringify(kept.content, null, 2)}\n`);

    // Act
    const outcome = await migration.migrate(plan.digest);

    // Assert
    should(outcome.kind).equal('migrated');
    should(JSON.parse(await readFile(path.join(machine.layout.assetsDirectory, written.file), 'utf8'))).deepEqual(written.content);
  });
});

describe('FleetMigration — resumable', () => {
  it('should finish a migration that was interrupted, without doing anything twice', async () => {
    // Arrange — the first run stops at the apply (the host is killed there)
    const machine = await firstRunMachine({ provenance: false });
    await divergeCopies(machine);
    const first = machine.migration({ apply: { apply: () => new Promise<void>(() => undefined) } });
    const { plan } = await first.dryRun();
    void first.migrate(plan.digest);
    const statePath = path.join(machine.layout.fleetDirectory, 'migration', 'state.json');
    for (let attempt = 0; attempt < 200; attempt++) {
      const text = await readFile(statePath, 'utf8').catch(() => '');
      if (text.includes('"config"')) break;
      await Bun.sleep(10);
    }

    // Act
    const status = await machine.migration().status();
    const refused = await machine.migration().migrate('another');
    const dryRun = machine.migration().dryRun();
    const resumed = await machine.migration().migrate(plan.digest);

    // Assert
    should(status).match({ kind: 'in-progress', digest: plan.digest, startedAt: NOW });
    should(refused).deepEqual({
      kind: 'refused',
      reasons: [`a migration approved as ${plan.digest} is half done; approve that one to finish it before anything else`],
    });
    await should(dryRun).be.rejectedWith(`a migration approved as ${plan.digest} is half done; approve it again to finish it`);
    if (resumed.kind !== 'migrated') throw new Error(`expected a migration, got ${resumed.kind}`);
    should(resumed.resumed).be.true();
    should(machine.applied).length(1);
    should(resumed.report.credentials.find(credential => credential.id === 'claude-default')?.retired.length).equal(2);
    should(await readFile(machine.configPath, 'utf8')).equal(renderConfig(plan.model));
  });

  it('should refuse to resume while a session runs, and to purge while it is half done', async () => {
    // Arrange
    const machine = await firstRunMachine();
    const first = machine.migration({ apply: { apply: () => new Promise<void>(() => undefined) } });
    const { plan } = await first.dryRun();
    void first.migrate(plan.digest);
    const statePath = path.join(machine.layout.fleetDirectory, 'migration', 'state.json');
    for (let attempt = 0; attempt < 200 && !(await readFile(statePath, 'utf8').catch(() => '')).includes('"config"'); attempt++) {
      await Bun.sleep(10);
    }
    machine.live = [{ session: 'chat', accountId: id(3) }];

    // Act
    const outcome = await machine.migration().migrate(plan.digest);
    const purge = machine.migration().purgeRetired();

    // Assert
    should(outcome).deepEqual({
      kind: 'refused',
      reasons: ['login codex-default is in use by running session chat; stop it and run the migration again'],
    });
    await should(purge).be.rejectedWith('a migration is half done; finish it before purging what earlier ones retired');
  });

  it('should refuse a saved migration this version cannot read', async () => {
    // Arrange
    const machine = await firstRunMachine();
    await mkdir(path.join(machine.layout.fleetDirectory, 'migration'), { recursive: true });
    const statePath = path.join(machine.layout.fleetDirectory, 'migration', 'state.json');
    await writeFile(statePath, '{"version":9}');

    // Act / Assert
    await should(machine.migration().status()).be.rejectedWith(`${statePath} holds a migration this version cannot read; it was left as it is`);
  });

  it('should keep an earlier attempt\'s backup that differs, under this attempt\'s folder', async () => {
    // Arrange
    const machine = await firstRunMachine();
    await writeFile(`${machine.configPath}.v1`, 'agents: []\n');

    // Act
    const { outcome } = await dryRunAndMigrate(machine);

    // Assert
    if (outcome.kind !== 'migrated') throw new Error('unreachable');
    should(await readFile(path.join(outcome.report.retired, 'documents', 'config.yaml.v1.previous'), 'utf8')).equal('agents: []\n');
    should(await readFile(`${machine.configPath}.v1`, 'utf8')).equal(machine.configText);
  });
});

describe('FleetMigration — macOS keychain', () => {
  it('should write the kept login into the item named for its store, and list the old items for a purge', async () => {
    // Arrange
    const machine = await firstRunMachine({ platform: 'darwin', provenance: false });
    machine.keychain.items.set(keychainService(machine.homes['claude-auto-default']), claudeBlob('new', NOW + 9 * HOUR));
    const store = path.join(machine.layout.fleetDirectory, 'credentials', 'claude-default');

    // Act
    const { outcome } = await dryRunAndMigrate(machine);

    // Assert
    if (outcome.kind !== 'migrated') throw new Error(`expected a migration, got ${JSON.stringify(outcome)}`);
    should(machine.keychain.items.get(secureStorageKeychainService(store))).equal(claudeBlob('new', NOW + 9 * HOUR));
    should(machine.keychain.items.has(keychainService(machine.homes['claude-default']))).be.true();
    const listed = JSON.parse(await readFile(path.join(outcome.report.retired, 'keychain.json'), 'utf8'));
    should(listed).deepEqual(
      [keychainService(machine.homes['claude-default']), keychainService(machine.homes['claude-auto-default'])].toSorted(),
    );
    should(outcome.report.credentials[0]?.retired).containEql(`keychain item "${keychainService(machine.homes['claude-default'])}" (until purged)`);

    // Act — the purge deletes what was listed, never your own item or a current login's
    const purge = await machine.migration().purgeRetired();

    // Assert
    should(purge.keychainItems.toSorted()).deepEqual(listed);
    should(purge.removed).deepEqual([outcome.report.retired]);
    should(machine.keychain.items.has(DEFAULT_KEYCHAIN_SERVICE)).be.true();
    should(machine.keychain.items.has(secureStorageKeychainService(store))).be.true();
    should(await machine.migration().purgeRetired()).deepEqual({ removed: [], keychainItems: [], kept: [] });
  });

  it('should keep a retired folder whose keychain items could not be deleted, and skip protected ones', async () => {
    // Arrange
    const machine = await firstRunMachine({ platform: 'darwin' });
    await dryRunAndMigrate(machine);
    const root = path.join(machine.layout.fleetDirectory, 'retired');
    const [folder] = await readdir(root);
    const listed = path.join(root, folder as string, 'keychain.json');
    await writeFile(listed, JSON.stringify([DEFAULT_KEYCHAIN_SERVICE, 7, 'Claude Code-credentials-gone', 'Claude Code-credentials-stuck']));
    machine.keychain.items.set('Claude Code-credentials-stuck', 'x');
    machine.keychain.failWith = {};
    const failing = machine.migration({
      command: {
        run: async (command, timeout, stdin) =>
          command.includes('Claude Code-credentials-stuck') ? { code: 51, stdout: '' } : machine.keychain.run(command, timeout, stdin),
      },
    });

    // Act
    const purge = await failing.purgeRetired();

    // Assert
    should(purge.keychainItems).deepEqual(['Claude Code-credentials-gone']);
    should(purge.kept).deepEqual([
      'keychain item "Claude Code-credentials-stuck" could not be deleted (exit 51)',
      path.join(root, folder as string),
    ]);
    should(machine.keychain.items.has(DEFAULT_KEYCHAIN_SERVICE)).be.true();
  });

  it('should roll back a keychain item it wrote, and keep one a harness changed since', async () => {
    // Arrange
    const machine = await firstRunMachine({ platform: 'darwin', provenance: false });
    machine.keychain.items.set(keychainService(machine.homes['claude-auto-default']), claudeBlob('new', NOW + 9 * HOUR));
    machine.applyFails = 'no';
    const store = secureStorageKeychainService(path.join(machine.layout.fleetDirectory, 'credentials', 'claude-default'));

    // Act
    const { outcome } = await dryRunAndMigrate(machine);

    // Assert
    should(outcome).match({ kind: 'rolled-back', unrestored: [] });
    should(machine.keychain.items.has(store)).be.false();

    // Arrange — again, with the stored item renewed before the failure
    const renewing = machine.migration({
      apply: {
        apply: async () => {
          machine.keychain.items.set(store, claudeBlob('renewed', NOW + 30 * HOUR));
          throw new Error('stop');
        },
      },
    });

    // Act
    const second = await dryRunAndMigrate(machine, renewing);

    // Assert
    should(second.outcome).match({
      kind: 'rolled-back',
      unrestored: [`keychain item "${store}" changed after the migration wrote it, so it was kept`],
    });
  });

  it('should leave nothing to undo for a keychain item already gone', async () => {
    // Arrange
    const machine = await firstRunMachine({ platform: 'darwin', provenance: false });
    machine.keychain.items.set(keychainService(machine.homes['claude-auto-default']), claudeBlob('new', NOW + 9 * HOUR));
    const store = secureStorageKeychainService(path.join(machine.layout.fleetDirectory, 'credentials', 'claude-default'));
    const migration = machine.migration({
      apply: {
        apply: async () => {
          machine.keychain.items.delete(store);
          throw new Error('stop');
        },
      },
    });

    // Act
    const { outcome } = await dryRunAndMigrate(machine, migration);

    // Assert
    should(outcome).match({ kind: 'rolled-back', unrestored: [] });
  });

  it('should roll back when the keychain refuses the write', async () => {
    // Arrange
    const machine = await firstRunMachine({ platform: 'darwin', provenance: false });
    machine.keychain.items.set(keychainService(machine.homes['claude-auto-default']), claudeBlob('new', NOW + 9 * HOUR));
    const migration = machine.migration();
    const { plan } = await migration.dryRun();
    machine.keychain.failWith = { write: 9 };

    // Act
    const outcome = await migration.migrate(plan.digest);

    // Assert
    should(outcome).match({ kind: 'rolled-back', reason: 'the keychain write failed (exit 9)' });
  });

  it('should refuse a keychain write it could not make without exposing the login', async () => {
    // Arrange
    const machine = await firstRunMachine({ platform: 'darwin', provenance: false });
    machine.keychain.items.set(keychainService(machine.homes['claude-auto-default']), claudeBlob('new', NOW + 9 * HOUR));

    // Act
    const { outcome } = await dryRunAndMigrate(machine, machine.migration({ keychainAccount: 'has"quote' }));

    // Assert
    should(outcome).match({
      kind: 'rolled-back',
      reason: 'the keychain write was refused, because it could not be made without exposing the login',
    });
  });
});

describe('FleetMigration — the edges of a machine', () => {
  it('should read an unreadable copy as a reason to wait, naming it', async () => {
    // Arrange
    const machine = await firstRunMachine();
    const credentials = new PlatformFleetCredentialStore({ platform: 'linux', command: machine.keychain, now: () => NOW, keychainAccount: 'x' });
    const migration = machine.migration({
      credentials: {
        storedMaterial: resolution => credentials.storedMaterial(resolution),
        material: async (kind, home) => {
          if (home === machine.homes['codex-default']) throw new Error('permission denied');
          return credentials.material(kind, home);
        },
      },
    });

    // Act
    const { dryRun, outcome } = await dryRunAndMigrate(machine, migration);

    // Assert
    should(dryRun.plan.blockers[0]?.message).startWith(
      `the login copy in ${machine.homes['codex-default']} (codex-default) could not be read (permission denied)`,
    );
    should(outcome.kind).equal('refused');
  });

  it('should treat a Codex home that already links to a file as no copy, and a host Codex home it cannot name as unavailable', async () => {
    // Arrange
    const machine = await firstRunMachine({ provenance: false });
    await rm(path.join(machine.homes['codex-auto-default'], 'auth.json'));
    await symlink(path.join(machine.userHome, '.codex', 'auth.json'), path.join(machine.homes['codex-auto-default'], 'auth.json'));
    const migration = machine.migration({ hostCodexHome: undefined });

    // Act
    const survey = await migration.survey(Bun.YAML.parse(machine.configText));

    // Assert
    should(survey.homes.find(home => home.home === machine.homes['codex-auto-default'])).match({
      state: 'missing',
      copies: [],
      linkedTo: path.join(machine.userHome, '.codex', 'auth.json'),
    });
    should(survey.host.codex).match({ directory: '', state: 'missing' });
  });

  it('should migrate a login whose host cannot be named, and skip a home that does not exist', async () => {
    // Arrange — no provenance and a Codex home the host cannot name: both logins stay in Ferretry
    const machine = await firstRunMachine({ provenance: false, hostLogins: false });
    await rm(machine.homes['codex-auto-default'], { recursive: true });
    const migration = machine.migration({ hostCodexHome: undefined });

    // Act
    const { outcome } = await dryRunAndMigrate(machine, migration);

    // Assert
    should(outcome.kind).equal('migrated');
    should(await exists(path.join(machine.homes['codex-auto-default'], 'auth.json'))).be.false();
  });

  it('should read a version-1 document with no agents and an MCP file into MCP servers', async () => {
    // Arrange
    const machine = await firstRunMachine();
    const config = Bun.YAML.parse(machine.configText) as { agents: Record<string, unknown>[] };
    (config.agents[0] as Record<string, unknown>).mcp = './mcp.json';
    config.agents.push({ name: 'x', kind: 'claude', mcp: './missing.json', routes: {} });
    config.agents.push({ name: 'y', kind: 'claude', mcp: './flat.json', routes: {} });
    config.agents.push({ name: 'z', kind: 'claude', mcp: './mcp.json', routes: {} });
    await writeFile(machine.configPath, Bun.YAML.stringify(config));
    await mkdir(machine.layout.assetsDirectory, { recursive: true });
    await writeFile(path.join(machine.layout.assetsDirectory, 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'npx' } } }));
    await writeFile(path.join(machine.layout.assetsDirectory, 'flat.json'), JSON.stringify([1]));

    // Act
    const survey = await machine.migration().survey(Bun.YAML.parse(await readFile(machine.configPath, 'utf8')));
    const empty = await machine.migration().survey(null);

    // Assert
    should(survey.mcpFiles['./mcp.json']).deepEqual({ ok: true, servers: { github: { command: 'npx' } } });
    should(survey.mcpFiles['./flat.json']).deepEqual({ ok: false, reason: 'it has no "mcpServers" object' });
    should(survey.mcpFiles['./missing.json']?.ok).equal(false);
    should(empty.homes).deepEqual([]);
  });

  it('should skip an environment login and survey nothing for it', async () => {
    // Arrange
    const machine = await firstRunMachine();
    const document = {
      agents: [
        {
          name: 'api',
          kind: 'claude',
          auth: 'api-key',
          env: { ANTHROPIC_API_KEY: '${secret:K}' },
          routes: { default: { id: id(9), wrapper: 'claude-api', home: 'claude-api', defaultModel: 'm', models: ['m'] } },
        },
      ],
    };
    await writeFile(machine.configPath, Bun.YAML.stringify(document));

    // Act
    const { outcome } = await dryRunAndMigrate(machine);

    // Assert
    if (outcome.kind !== 'migrated') throw new Error(`expected a migration, got ${outcome.kind}`);
    should(outcome.report.credentials).deepEqual([
      { id: 'claude-api', harness: 'claude', store: 'environment', kept: 'its environment variables', retired: [] },
    ]);
  });

  it('should leave an empty slot for a login with no usable copy, and report it as needing sign-in', async () => {
    // Arrange
    const machine = await firstRunMachine({ provenance: false, hostLogins: false });
    for (const wrapper of WRAPPERS) {
      await writeFile(path.join(machine.homes[wrapper], wrapper.startsWith('claude') ? '.credentials.json' : 'auth.json'), '{}');
    }

    // Act
    const { outcome } = await dryRunAndMigrate(machine);

    // Assert
    if (outcome.kind !== 'migrated') throw new Error(`expected a migration, got ${outcome.kind}`);
    should(outcome.report.credentials[0]?.kept).equal('nothing; needs sign-in');
  });

  it('should refuse to touch a file inside your own harness directory, whatever a plan says', async () => {
    // Arrange — a hand-edited saved plan that would retire your own login
    const machine = await firstRunMachine();
    const migration = machine.migration();
    const { plan } = await migration.dryRun();
    const own = path.join(machine.userHome, '.claude', '.credentials.json');
    const tampered = {
      ...plan,
      credentials: plan.credentials.map(credential =>
        credential.id === 'claude-default'
          ? {
              ...credential,
              retire: [
                { accountId: id(0), wrapper: 'x', home: path.join(machine.userHome, '.claude'), copy: { kind: 'file', path: own } },
              ],
            }
          : credential,
      ),
    };
    await mkdir(path.join(machine.layout.fleetDirectory, 'migration'), { recursive: true });
    await writeFile(
      path.join(machine.layout.fleetDirectory, 'migration', 'state.json'),
      JSON.stringify({
        version: 1,
        startedAt: NOW,
        retired: path.join(machine.layout.fleetDirectory, 'retired', `${NOW}`),
        plan: {
          digest: plan.digest,
          model: tampered.model,
          ids: tampered.ids,
          credentials: tampered.credentials,
          runtimes: tampered.runtimes,
          historyPooled: tampered.historyPooled,
          settingsBodies: tampered.settingsBodies,
        },
        actions: [],
      }),
    );

    // Act
    const outcome = await migration.migrate(plan.digest);

    // Assert
    should(outcome).match({
      kind: 'rolled-back',
      reason: `${path.join(machine.userHome, '.claude')} is your own claude login, which a migration never changes`,
    });
    should(await exists(own)).be.true();
  });

  it('should refuse when config.yaml disappears mid-way', async () => {
    // Arrange
    const machine = await firstRunMachine();
    const migration = machine.migration();
    const { plan } = await migration.dryRun();
    await mkdir(path.join(machine.layout.fleetDirectory, 'migration'), { recursive: true });
    await writeFile(
      path.join(machine.layout.fleetDirectory, 'migration', 'state.json'),
      JSON.stringify({
        version: 1,
        startedAt: NOW,
        retired: path.join(machine.layout.fleetDirectory, 'retired', `${NOW}`),
        plan: {
          digest: plan.digest,
          model: plan.model,
          ids: plan.ids,
          credentials: plan.credentials,
          runtimes: plan.runtimes,
          historyPooled: plan.historyPooled,
          settingsBodies: plan.settingsBodies,
        },
        actions: [],
      }),
    );
    await rm(machine.configPath);

    // Act
    const outcome = await migration.migrate(plan.digest);

    // Assert
    should(outcome).match({ kind: 'rolled-back', reason: `${machine.configPath} is gone` });
  });
});
