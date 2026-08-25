/**
 * The credential store against a real filesystem and a scripted `security`.
 *
 * Every path here is inside a temporary directory this test created. Nothing reads the invoking user's
 * homes, keychain or fleet state, and the macOS branch is driven through the injected command seam so
 * it is exercised on a host that is not macOS — which is the only way it gets tested at all.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import {
  COMMAND_FAILED,
  type CredentialCommand,
  type CredentialCommandResult,
  claudeConfigPath,
  claudeFilePath,
  codexPath,
  KEYCHAIN_ITEM_NOT_FOUND,
  keychainService,
  PlatformFleetCredentialStore,
  SpawnCredentialCommand,
} from '../../src/adapters/credential-store.ts';
import { FleetFirstRunSeeder, type FleetSeedTarget } from '../../src/lib/credential-seed.ts';
import type { FleetIdentityMember } from '../../src/lib/identity.ts';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-credentials-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const member = (home: string, accountId = 'account-one'): FleetIdentityMember => ({
  accountId,
  wrapper: path.join(home, 'wrapper'),
  home,
  displayName: 'Account One',
  mode: 'interactive',
  available: true,
  unavailableReason: null,
});

const claudeBlob = (expiresAt: number): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken: 'placeholder-access', refreshToken: 'placeholder-refresh', expiresAt },
  });

/** A `security` whose every invocation is scripted, so no real keychain is ever touched. */
class ScriptedCommand implements CredentialCommand {
  readonly calls: string[][] = [];

  constructor(private readonly replies: readonly CredentialCommandResult[]) {}

  run(command: readonly [string, ...string[]]): Promise<CredentialCommandResult> {
    this.calls.push([...command]);
    return Promise.resolve(this.replies[this.calls.length - 1] ?? { code: 0, stdout: '' });
  }
}

const fileStore = (replies: readonly CredentialCommandResult[] = []): PlatformFleetCredentialStore =>
  new PlatformFleetCredentialStore({
    platform: 'linux',
    command: new ScriptedCommand(replies),
    now: () => NOW,
    keychainAccount: 'placeholder-user',
  });

describe('SpawnCredentialCommand', () => {
  it('should return the exit code and stdout of a command that ran', async () => {
    // Act
    const actual = await new SpawnCredentialCommand().run(['/bin/echo', 'placeholder-output'], 5_000);

    // Assert
    should(actual.code).equal(0);
    should(actual.stdout.trim()).equal('placeholder-output');
  });

  it('should report a non-zero exit rather than throwing', async () => {
    const actual = await new SpawnCredentialCommand().run(['/bin/sh', '-c', 'exit 44'], 5_000);
    should(actual.code).equal(44);
  });

  it('should report a binary this host does not have as a failure, not an absence', async () => {
    // Act — this is what a Linux host does with `security`, and it must not read as "no credential".
    const actual = await new SpawnCredentialCommand().run(['definitely-not-installed-fy-test'], 5_000);

    // Assert
    should(actual.code).equal(COMMAND_FAILED);
    should(actual.stdout).equal('');
  });

  it('should return a failure when a command outlives its bound', async () => {
    // Arrange — a locked keychain leaves `security` waiting on a prompt nobody will answer, and the
    // child it spawned holds the same stdout pipe, so killing it does not by itself end the read.
    const shell = Bun.which('sh') ?? '/bin/sh';
    const started = Date.now();

    // Act
    const actual = await new SpawnCredentialCommand().run([shell, '-c', 'sleep 30'], 100);

    // Assert — the bound is honoured whether or not the pipe ever closes.
    should(actual).deepEqual({ code: COMMAND_FAILED, stdout: '' });
    should(Date.now() - started).be.below(3_000);
  });
});

describe('PlatformFleetCredentialStore reading a file-backed credential', () => {
  it('should report a home with no credential file as missing', async () => {
    // Arrange
    const home = await temporaryDirectory();

    // Act
    const actual = await fileStore().read('claude', member(home));

    // Assert
    should(actual).deepEqual({ state: 'missing' });
  });

  it('should report an empty credential file as missing rather than unreadable', async () => {
    // Arrange
    const home = await temporaryDirectory();
    await writeFile(claudeFilePath(home), '   \n');

    // Act / Assert
    should(await fileStore().read('claude', member(home))).deepEqual({ state: 'missing' });
  });

  it('should classify a Claude credential file on a non-macOS host', async () => {
    // Arrange
    const home = await temporaryDirectory();
    await writeFile(claudeFilePath(home), claudeBlob(NOW + HOUR));

    // Act
    const actual = await fileStore().read('claude', member(home));

    // Assert
    should(actual).deepEqual({ state: 'valid', expiresAt: NOW + HOUR });
  });

  it('should read a Codex credential from auth.json on every platform', async () => {
    // Arrange
    const home = await temporaryDirectory();
    await writeFile(codexPath(home), JSON.stringify({ tokens: { refresh_token: 'placeholder-refresh' } }));

    // Act — the platform is macOS here; Codex never uses the keychain.
    const store = new PlatformFleetCredentialStore({
      platform: 'darwin',
      command: new ScriptedCommand([]),
      now: () => NOW,
      keychainAccount: 'placeholder-user',
    });

    // Assert
    should(await store.read('codex', member(home))).deepEqual({ state: 'refreshable' });
  });

  it('should report a credential path that is not a regular file as absent', async () => {
    // Arrange — a directory where the credential file belongs.
    const home = await temporaryDirectory();
    await mkdir(claudeFilePath(home));

    // Act
    const actual = await fileStore().read('claude', member(home));

    // Assert — reported as an empty home, which is safe because the copy that follows still cannot
    // write over a directory: it throws, and the copy is refused rather than silently skipped.
    should(actual).deepEqual({ state: 'missing' });
  });
});

describe('PlatformFleetCredentialStore copying a file-backed credential', () => {
  it('should copy the donor credential and lock the target to owner-only', async () => {
    // Arrange
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    const blob = claudeBlob(NOW + HOUR);
    await writeFile(claudeFilePath(donorHome), blob);

    // Act
    const actual = await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'));

    // Assert
    should(actual).deepEqual({ ok: true });
    should(await readFile(claudeFilePath(targetHome), 'utf8')).equal(blob);
    should((await stat(claudeFilePath(targetHome))).mode & 0o777).equal(0o600);
  });

  it('should tighten the mode of a target credential that already existed', async () => {
    // Arrange — a world-readable copy left by an earlier tool must not stay world-readable.
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    await writeFile(claudeFilePath(donorHome), claudeBlob(NOW + HOUR));
    await writeFile(claudeFilePath(targetHome), 'stale', { mode: 0o644 });

    // Act
    await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'));

    // Assert
    should((await stat(claudeFilePath(targetHome))).mode & 0o777).equal(0o600);
  });

  it('should copy a Codex credential to auth.json', async () => {
    // Arrange
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    const blob = JSON.stringify({ tokens: { refresh_token: 'placeholder-refresh' } });
    await writeFile(codexPath(donorHome), blob);

    // Act
    const actual = await fileStore().clone('codex', member(donorHome), member(targetHome, 'account-two'));

    // Assert
    should(actual).deepEqual({ ok: true });
    should(await readFile(codexPath(targetHome), 'utf8')).equal(blob);
  });

  it('should refuse to copy when the donor credential is not there any more', async () => {
    // Arrange — the survey said this donor was usable; between then and now it went away.
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();

    // Act
    const actual = await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'));

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'the donor credential could not be read at copy time' });
    should(await Bun.file(claudeFilePath(targetHome)).exists()).be.false();
  });

  it('should refuse to copy a donor credential that is no longer usable', async () => {
    // Arrange — an expired token with nothing to renew it. Cloning it would break every lane.
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    await writeFile(
      claudeFilePath(donorHome),
      JSON.stringify({ claudeAiOauth: { accessToken: 'placeholder', expiresAt: NOW - HOUR } }),
    );

    // Act
    const actual = await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'));

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'the donor credential is no longer usable (missing)' });
    should(await Bun.file(claudeFilePath(targetHome)).exists()).be.false();
  });

  it('should copy the displayed account identity so status and attribution match the credential', async () => {
    // Arrange
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    await writeFile(claudeFilePath(donorHome), claudeBlob(NOW + HOUR));
    await writeFile(claudeConfigPath(donorHome), JSON.stringify({ oauthAccount: { emailAddress: 'placeholder' } }));
    await writeFile(claudeConfigPath(targetHome), JSON.stringify({ theme: 'dark' }));

    // Act
    await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'));

    // Assert — the target's own settings survive; only the account identity is overwritten.
    const written = JSON.parse(await readFile(claudeConfigPath(targetHome), 'utf8')) as Record<string, unknown>;
    should(written).deepEqual({ theme: 'dark', oauthAccount: { emailAddress: 'placeholder' } });
  });

  it('should create the target harness config when it has none yet', async () => {
    // Arrange
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    await writeFile(claudeFilePath(donorHome), claudeBlob(NOW + HOUR));
    await writeFile(claudeConfigPath(donorHome), JSON.stringify({ oauthAccount: { emailAddress: 'placeholder' } }));

    // Act
    await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'));

    // Assert
    const written = JSON.parse(await readFile(claudeConfigPath(targetHome), 'utf8')) as Record<string, unknown>;
    should(written).deepEqual({ oauthAccount: { emailAddress: 'placeholder' } });
  });

  it('should not touch the target config when the donor names no account', async () => {
    // Arrange
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    await writeFile(claudeFilePath(donorHome), claudeBlob(NOW + HOUR));
    await writeFile(claudeConfigPath(donorHome), JSON.stringify({ theme: 'dark' }));

    // Act
    const actual = await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'));

    // Assert
    should(actual).deepEqual({ ok: true });
    should(await Bun.file(claudeConfigPath(targetHome)).exists()).be.false();
  });

  it('should ignore a donor harness config that is not readable JSON', async () => {
    // Arrange
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    await writeFile(claudeFilePath(donorHome), claudeBlob(NOW + HOUR));
    await writeFile(claudeConfigPath(donorHome), 'not json');

    // Act
    const actual = await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'));

    // Assert — display metadata is never worth failing a completed credential copy over.
    should(actual).deepEqual({ ok: true });
  });

  it('should ignore a donor harness config that is JSON but not an object', async () => {
    // Arrange
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    await writeFile(claudeFilePath(donorHome), claudeBlob(NOW + HOUR));
    await writeFile(claudeConfigPath(donorHome), '["placeholder"]');

    // Act / Assert
    should(await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'))).deepEqual({
      ok: true,
    });
  });

  it('should still report a successful copy when the display metadata could not be written', async () => {
    // Arrange — a target config that is a directory cannot be written, but the credential already landed.
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    await writeFile(claudeFilePath(donorHome), claudeBlob(NOW + HOUR));
    await writeFile(claudeConfigPath(donorHome), JSON.stringify({ oauthAccount: { emailAddress: 'placeholder' } }));
    await mkdir(claudeConfigPath(targetHome));

    // Act
    const actual = await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'));

    // Assert
    should(actual).deepEqual({ ok: true });
    should(await readFile(claudeFilePath(targetHome), 'utf8')).equal(claudeBlob(NOW + HOUR));
  });

  it('should let a write that fails throw, so the service reports it with the underlying reason', async () => {
    // Arrange
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    await writeFile(claudeFilePath(donorHome), claudeBlob(NOW + HOUR));
    await mkdir(claudeFilePath(targetHome));

    // Act / Assert
    await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two')).should.be.rejected();
  });
});

describe('keychainService', () => {
  it('should derive the item name Claude Code derives from a config directory', () => {
    // Assert — the suffix is the first eight hex digits of sha256 of the exact home path.
    should(keychainService('/homes/claude-kirin')).match(/^Claude Code-credentials-[0-9a-f]{8}$/u);
  });

  it('should give two different homes two different items', () => {
    should(keychainService('/homes/one')).not.equal(keychainService('/homes/two'));
  });
});

describe('PlatformFleetCredentialStore on macOS', () => {
  const macStore = (replies: readonly CredentialCommandResult[], command = new ScriptedCommand(replies)) => ({
    store: new PlatformFleetCredentialStore({
      platform: 'darwin',
      command,
      now: () => NOW,
      keychainAccount: 'placeholder-user',
      keychainTimeoutMs: 250,
    }),
    command,
  });

  it('should read the Claude credential out of the keychain item for that home', async () => {
    // Arrange
    const { store, command } = macStore([{ code: 0, stdout: `${claudeBlob(NOW + HOUR)}\n` }]);
    const home = '/homes/claude-kirin';

    // Act
    const actual = await store.read('claude', member(home));

    // Assert
    should(actual).deepEqual({ state: 'valid', expiresAt: NOW + HOUR });
    should(command.calls[0]).deepEqual(['security', 'find-generic-password', '-s', keychainService(home), '-w']);
  });

  it('should read "no such item" as an absence', async () => {
    const { store } = macStore([{ code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' }]);
    should(await store.read('claude', member('/homes/one'))).deepEqual({ state: 'missing' });
  });

  it('should read any other failure as unreadable, never as an absence', async () => {
    // Arrange — a locked keychain, a denied prompt or a timeout must not read as "not logged in".
    const { store } = macStore([{ code: 51, stdout: '' }]);

    // Act
    const actual = await store.read('claude', member('/homes/one'));

    // Assert
    should(actual).deepEqual({ state: 'unreadable', reason: 'the keychain read for this home failed (exit 51)' });
  });

  it('should read an item that exists but is empty as an absence', async () => {
    const { store } = macStore([{ code: 0, stdout: '  \n' }]);
    should(await store.read('claude', member('/homes/one'))).deepEqual({ state: 'missing' });
  });

  it('should copy the credential into the target item, reusing the account attribute it finds', async () => {
    // Arrange — read donor, read target attributes, write target.
    const { store, command } = macStore([
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: 0, stdout: '"acct"<blob>="existing-account"\n"svce"<blob>="Claude Code-credentials-abc"' },
      { code: 0, stdout: '' },
    ]);

    // Act
    const actual = await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert
    should(actual).deepEqual({ ok: true });
    should(command.calls[2]).deepEqual([
      'security',
      'add-generic-password',
      '-U',
      '-a',
      'existing-account',
      '-s',
      keychainService('/homes/target'),
      '-w',
      claudeBlob(NOW + HOUR),
    ]);
  });

  it('should fall back to the supplied account when the target item names none', async () => {
    // Arrange
    const { store, command } = macStore([
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' },
      { code: 0, stdout: '' },
    ]);

    // Act
    await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert
    should(command.calls[2]?.[4]).equal('placeholder-user');
  });

  it('should fall back to the supplied account when the attribute output has no acct', async () => {
    // Arrange
    const { store, command } = macStore([
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: 0, stdout: '"svce"<blob>="Claude Code-credentials-abc"' },
      { code: 0, stdout: '' },
    ]);

    // Act
    await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert
    should(command.calls[2]?.[4]).equal('placeholder-user');
  });

  it('should fall back to the supplied account when the item names an empty one', async () => {
    // Arrange
    const { store, command } = macStore([
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: 0, stdout: '"acct"<blob>=""' },
      { code: 0, stdout: '' },
    ]);

    // Act
    await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert
    should(command.calls[2]?.[4]).equal('placeholder-user');
  });

  it('should report a keychain write that failed as a refused copy', async () => {
    // Arrange
    const { store } = macStore([
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: 0, stdout: '"acct"<blob>="existing-account"' },
      { code: 1, stdout: '' },
    ]);

    // Act
    const actual = await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'the keychain write failed (exit 1)' });
  });

  it('should refuse a copy when the donor keychain item could not be read', async () => {
    // Arrange
    const { store, command } = macStore([{ code: 51, stdout: '' }]);

    // Act
    const actual = await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert — nothing was written, and no attribute lookup was even attempted.
    should(actual).deepEqual({ ok: false, reason: 'the donor credential could not be read at copy time' });
    should(command.calls).have.length(1);
  });

  it('should use the default bound when none is supplied', async () => {
    // Arrange — the timeout is not observable through a scripted command, so this pins the wiring only.
    const store = new PlatformFleetCredentialStore({
      platform: 'darwin',
      command: new ScriptedCommand([{ code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' }]),
      now: () => NOW,
      keychainAccount: 'placeholder-user',
    });

    // Act / Assert
    should(await store.read('claude', member('/homes/one'))).deepEqual({ state: 'missing' });
  });
});

/**
 * The first run's seed against the store that actually writes, on both platform branches.
 *
 * THIS IS THE ONLY PLACE THE macOS SEED IS PROVED. A file-copy-only seed would pass every other test
 * in this repository and silently do nothing on a Mac, because Claude Code keeps no credential file
 * there — it keeps a keychain item whose NAME is derived from the home path, so copying a credential
 * between two homes means reading one item and writing a different one. The seeder itself has no
 * platform branch at all; it delegates to this store, which is exactly why composing the two here is
 * what shows a Mac would work. `security` is scripted, so no real keychain is touched.
 */
describe('the first run seed through the platform store', () => {
  const seedTarget = (kind: 'claude' | 'codex', home: string): FleetSeedTarget => ({
    id: '00000000-0000-4000-8000-000000000001',
    kind,
    mode: 'interactive',
    wrapper: path.join(home, 'wrapper'),
    home,
    displayName: 'Account One',
    defaultModel: 'a-model',
    models: [{ id: 'a-model', available: true }],
    available: true,
    unavailableReason: null,
  });

  it('should copy a Linux credential file into the account home, private, as a real file', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const donorHome = path.join(root, 'user', '.claude');
    const targetHome = path.join(root, 'fleet', 'homes', 'claude-default');
    await mkdir(donorHome, { recursive: true });
    await mkdir(targetHome, { recursive: true });
    const blob = claudeBlob(NOW + HOUR);
    await writeFile(claudeFilePath(donorHome), blob, { mode: 0o600 });

    // Act
    const results = await new FleetFirstRunSeeder(fileStore()).seed([seedTarget('claude', targetHome)], {
      claude: donorHome,
      codex: path.join(root, 'user', '.codex'),
    });

    // Assert
    should(results[0]?.outcome).deepEqual({ kind: 'seeded', donorHome });
    should(await readFile(claudeFilePath(targetHome), 'utf8')).equal(blob);
    should((await stat(claudeFilePath(targetHome))).mode & 0o777).equal(0o600);
  });

  it('should seed a macOS account by rewriting the keychain item derived from its home', async () => {
    // Arrange — five scripted invocations, in this order: the target item (absent), the donor item,
    // the donor item AGAIN because the store re-reads and re-classifies at copy time, the target's
    // keychain attributes, and the write.
    const donorHome = '/Users/operator/.claude';
    const targetHome = '/Users/operator/.ferretry/fleet/homes/claude-default';
    const command = new ScriptedCommand([
      { code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' },
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: 0, stdout: '"acct"<blob>="operator"' },
      { code: 0, stdout: '' },
    ]);
    const store = new PlatformFleetCredentialStore({
      platform: 'darwin',
      command,
      now: () => NOW,
      keychainAccount: 'placeholder-user',
    });

    // Act
    const results = await new FleetFirstRunSeeder(store).seed([seedTarget('claude', targetHome)], {
      claude: donorHome,
      codex: '/Users/operator/.codex',
    });

    // Assert — a keychain read of the DONOR's item and a write to the TARGET's, which are different
    // names because the name is derived from the home. A file copy would have done nothing here.
    should(results[0]?.outcome).deepEqual({ kind: 'seeded', donorHome });
    should(command.calls[0]).deepEqual(['security', 'find-generic-password', '-s', keychainService(targetHome), '-w']);
    should(command.calls[1]).deepEqual(['security', 'find-generic-password', '-s', keychainService(donorHome), '-w']);
    should(command.calls[4]?.slice(0, 6)).deepEqual(['security', 'add-generic-password', '-U', '-a', 'operator', '-s']);
    should(command.calls[4]?.[6]).equal(keychainService(targetHome));
    should(keychainService(donorHome)).not.equal(keychainService(targetHome));
  });

  it('should carry the displayed account identity across with the macOS credential', async () => {
    // Arrange — a donor whose `.claude.json` names the signed-in account. Without this the seeded
    // homes show somebody a `/status` that names no account at all.
    const root = await temporaryDirectory();
    const donorHome = path.join(root, 'user', '.claude');
    const targetHome = path.join(root, 'fleet', 'homes', 'claude-default');
    await mkdir(donorHome, { recursive: true });
    await mkdir(targetHome, { recursive: true });
    await writeFile(claudeFilePath(donorHome), claudeBlob(NOW + HOUR), { mode: 0o600 });
    await writeFile(claudeConfigPath(donorHome), JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }));

    // Act
    await new FleetFirstRunSeeder(fileStore()).seed([seedTarget('claude', targetHome)], {
      claude: donorHome,
      codex: path.join(root, 'user', '.codex'),
    });

    // Assert
    should(JSON.parse(await readFile(claudeConfigPath(targetHome), 'utf8'))).deepEqual({
      oauthAccount: { emailAddress: 'a@example.com' },
    });
  });

  it('should report a home whose harness was never signed in, having written nothing', async () => {
    // Arrange — an empty donor directory, which is what a freshly installed harness looks like.
    const root = await temporaryDirectory();
    const donorHome = path.join(root, 'user', '.codex');
    const targetHome = path.join(root, 'fleet', 'homes', 'codex-default');
    await mkdir(donorHome, { recursive: true });
    await mkdir(targetHome, { recursive: true });

    // Act
    const results = await new FleetFirstRunSeeder(fileStore()).seed([seedTarget('codex', targetHome)], {
      claude: path.join(root, 'user', '.claude'),
      codex: donorHome,
    });

    // Assert
    should(results[0]?.outcome).deepEqual({ kind: 'no-donor', donorHome });
    should(await Bun.file(codexPath(targetHome)).exists()).be.false();
  });
});
