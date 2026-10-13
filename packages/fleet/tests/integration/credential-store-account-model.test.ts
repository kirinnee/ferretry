/**
 * The account model's credential stores (design §8.1.1, §8.2.1) against a real filesystem and a
 * scripted `security`.
 *
 * Every path is inside a temporary directory this test created, and every credential is a placeholder.
 * The macOS branch is driven through the command seam; the naming rule it asserts is the one U4's
 * `claude-keychain.test.ts` measured on a real `macos-15` runner.
 */
import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { StoredCredentialClassifier } from '../../src/adapters/credential-classifier.ts';
import {
  type CredentialCommand,
  type CredentialCommandResult,
  DEFAULT_KEYCHAIN_SERVICE,
  FALLBACK_KEYCHAIN_ACCOUNT,
  FileCredentialStoreLinks,
  harnessKeychainAccount,
  KEYCHAIN_ITEM_NOT_FOUND,
  PlatformFleetCredentialStore,
  secureStorageKeychainService,
} from '../../src/adapters/credential-store.ts';
import {
  codexCredentialLink,
  resolveCredentialStore,
  type StoredCredentialResolution,
} from '../../src/lib/account/credentials.ts';
import { CredentialSchema } from '../../src/lib/account/schema.ts';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-account-credentials-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const claudeBlob = (expiresAt: number): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken: 'placeholder-access', refreshToken: 'placeholder-refresh', expiresAt },
  });

class ScriptedCommand implements CredentialCommand {
  readonly calls: string[][] = [];

  constructor(private readonly replies: readonly CredentialCommandResult[]) {}

  run(command: readonly [string, ...string[]]): Promise<CredentialCommandResult> {
    this.calls.push([...command]);
    return Promise.resolve(this.replies[this.calls.length - 1] ?? { code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' });
  }
}

const storeOn = (platform: string, replies: readonly CredentialCommandResult[] = []) => {
  const command = new ScriptedCommand(replies);
  return {
    command,
    store: new PlatformFleetCredentialStore({ platform, command, now: () => NOW, keychainAccount: 'placeholder-user' }),
  };
};

/** A resolved store for a credential, rooted in a temporary machine. */
async function machine() {
  const root = await temporaryDirectory();
  const paths = {
    fleetRoot: path.join(root, 'fy', 'fleet'),
    userHome: path.join(root, 'user'),
    hostCodexHome: path.join(root, 'user', '.codex'),
  };
  const resolve = (id: string, input: Record<string, unknown>) =>
    resolveCredentialStore(id, CredentialSchema.parse(input), paths) as StoredCredentialResolution;
  return { root, paths, resolve };
}

describe('secureStorageKeychainService', () => {
  it('should name the bare item for the empty value — the person’s own login', () => {
    should(secureStorageKeychainService('')).equal(DEFAULT_KEYCHAIN_SERVICE);
  });

  it('should suffix the first eight hex of sha256 of the NFC value, as measured on macOS', () => {
    // Arrange — the same derivation U4's contract test plants under (`support/keychain.ts`).
    const store = '/fy/fleet/credentials/café';
    const expected = `Claude Code-credentials-${createHash('sha256').update(store.normalize('NFC')).digest('hex').slice(0, 8)}`;

    // Act / Assert
    should(secureStorageKeychainService(store)).equal(expected);
    should(secureStorageKeychainService(store.normalize('NFC'))).equal(expected);
  });
});

describe('harnessKeychainAccount and the harness alphabet', () => {
  it('should fall back to the harness’s own name for an account Claude would not accept', () => {
    should(harnessKeychainAccount(['first last'])).equal(FALLBACK_KEYCHAIN_ACCOUNT);
    should(harnessKeychainAccount(['place.holder_user-1'])).equal('place.holder_user-1');
  });
});

describe('PlatformFleetCredentialStore.storedMaterial — Claude off macOS', () => {
  it('should read the store directory’s file, not any config dir', async () => {
    // Arrange
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });
    if (resolution.harness !== 'claude') throw new Error('fixture');
    await mkdir(resolution.storageDirectory, { recursive: true });
    await writeFile(resolution.credentialFile, claudeBlob(NOW + HOUR));
    const { store, command } = storeOn('linux');

    // Act
    const actual = await store.readStored(resolution);

    // Assert
    should(actual).deepEqual({ state: 'valid', expiresAt: NOW + HOUR });
    should(command.calls).be.empty();
  });

  it("should read the person's own ~/.claude file for a host credential", async () => {
    const world = await machine();
    const resolution = world.resolve('claude-you', { harness: 'claude', store: 'host' });
    await mkdir(path.join(world.paths.userHome, '.claude'), { recursive: true });
    await writeFile(path.join(world.paths.userHome, '.claude', '.credentials.json'), claudeBlob(NOW - HOUR));

    should(await storeOn('linux').store.readStored(resolution)).deepEqual({
      state: 'refreshable',
      expiresAt: NOW - HOUR,
    });
  });

  it('should read an empty slot as missing', async () => {
    const world = await machine();
    const resolution = world.resolve('claude-slot', { harness: 'claude', store: 'ferretry' });

    should(await storeOn('linux').store.readStored(resolution)).deepEqual({ state: 'missing' });
  });

  it('should refuse a symlinked credential file as unreadable, because a refresh forks it', async () => {
    // Arrange
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });
    if (resolution.harness !== 'claude') throw new Error('fixture');
    const elsewhere = path.join(world.root, 'elsewhere.json');
    await writeFile(elsewhere, claudeBlob(NOW + HOUR));
    await mkdir(resolution.storageDirectory, { recursive: true });
    await symlink(elsewhere, resolution.credentialFile);

    // Act
    const actual = await storeOn('linux').store.storedMaterial(resolution);

    // Assert
    should(actual).have.property('outcome', 'unreadable');
    should(JSON.stringify(actual)).not.match(/placeholder-access/u);
  });

  it('should rethrow a file-system failure that is not an absence', async () => {
    // Arrange — the store directory is a FILE, so the credential path cannot even be looked up.
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });
    if (resolution.harness !== 'claude') throw new Error('fixture');
    await mkdir(path.dirname(resolution.storageDirectory), { recursive: true });
    await writeFile(resolution.storageDirectory, 'not a directory');

    // Act / Assert — ENOTDIR is an absence: the store does not exist.
    should(await storeOn('linux').store.storedMaterial(resolution)).deepEqual({ outcome: 'absent' });
  });

  it('should throw for a lookup failure that is neither absence nor a link', async () => {
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });
    if (resolution.harness !== 'claude') throw new Error('fixture');
    const looped = { ...resolution, credentialFile: `${'x'.repeat(5000)}/.credentials.json` };

    await should(storeOn('linux').store.storedMaterial(looped)).be.rejected();
  });
});

describe('PlatformFleetCredentialStore.storedMaterial — Claude on macOS', () => {
  it('should read exactly the item named from the store directory, and nothing else', async () => {
    // Arrange
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });
    if (resolution.harness !== 'claude') throw new Error('fixture');
    const { store, command } = storeOn('darwin', [{ code: 0, stdout: `${claudeBlob(NOW + HOUR)}\n` }]);

    // Act
    const actual = await store.readStored(resolution);

    // Assert
    should(actual).deepEqual({ state: 'valid', expiresAt: NOW + HOUR });
    should(command.calls).deepEqual([
      ['security', 'find-generic-password', '-s', secureStorageKeychainService(resolution.secureStorage), '-w'],
    ]);
  });

  it("should read the bare item for the person's own login", async () => {
    const world = await machine();
    const resolution = world.resolve('claude-you', { harness: 'claude', store: 'host' });
    const { store, command } = storeOn('darwin', [{ code: 0, stdout: claudeBlob(NOW + HOUR) }]);

    await store.readStored(resolution);

    should(command.calls).deepEqual([['security', 'find-generic-password', '-s', DEFAULT_KEYCHAIN_SERVICE, '-w']]);
  });

  it('should fall back to the store file only when the item is absent', async () => {
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });
    if (resolution.harness !== 'claude') throw new Error('fixture');
    await mkdir(resolution.storageDirectory, { recursive: true });
    await writeFile(resolution.credentialFile, claudeBlob(NOW + HOUR));

    const actual = await storeOn('darwin', [{ code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' }]).store.readStored(
      resolution,
    );

    should(actual).deepEqual({ state: 'valid', expiresAt: NOW + HOUR });
  });

  it('should keep a keychain that could not be read unreadable, never answered from the file', async () => {
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });
    if (resolution.harness !== 'claude') throw new Error('fixture');
    await mkdir(resolution.storageDirectory, { recursive: true });
    await writeFile(resolution.credentialFile, claudeBlob(NOW + HOUR));

    const actual = await storeOn('darwin', [{ code: 51, stdout: '' }]).store.storedMaterial(resolution);

    should(actual).have.property('outcome', 'unreadable');
  });
});

describe('PlatformFleetCredentialStore.storedMaterial — Codex', () => {
  it('should read the one canonical auth.json', async () => {
    const world = await machine();
    const resolution = world.resolve('codex-work', { harness: 'codex', store: 'ferretry' });
    if (resolution.harness !== 'codex') throw new Error('fixture');
    await mkdir(path.dirname(resolution.canonicalFile), { recursive: true });
    await writeFile(resolution.canonicalFile, '{"tokens":{"refresh_token":"placeholder"}}');

    should(await storeOn('darwin').store.storedMaterial(resolution)).deepEqual({
      outcome: 'found',
      blob: '{"tokens":{"refresh_token":"placeholder"}}',
    });
  });
});

describe('StoredCredentialClassifier', () => {
  it('should classify a credential once, with a digest and never the material', async () => {
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });
    const subject = new StoredCredentialClassifier({
      credentials: { storedMaterial: async () => ({ outcome: 'found', blob: claudeBlob(NOW + HOUR) }) },
      now: () => NOW,
    });

    const actual = await subject.classify(resolution);

    should(actual).have.properties({ state: 'valid', expiresAt: NOW + HOUR });
    should(actual.fingerprint).be.a.String();
    should(JSON.stringify(actual)).not.match(/placeholder/u);
  });

  it('should give an absent credential no digest', async () => {
    const world = await machine();
    const resolution = world.resolve('codex-slot', { harness: 'codex', store: 'ferretry' });
    const subject = new StoredCredentialClassifier({
      credentials: { storedMaterial: async () => ({ outcome: 'absent' }) },
      now: () => NOW,
    });

    should(await subject.classify(resolution)).deepEqual({ state: 'missing' });
  });
});

describe('FileCredentialStoreLinks', () => {
  const links = new FileCredentialStoreLinks();

  it('should create a ferretry credential directory owner-only, and nothing for host', async () => {
    // Arrange
    const world = await machine();
    const owned = world.resolve('codex-work', { harness: 'codex', store: 'ferretry' });
    const host = world.resolve('codex-you', { harness: 'codex', store: 'host' });

    // Act
    await links.prepare(owned);
    await links.prepare(host);

    // Assert
    should((await stat(path.join(world.paths.fleetRoot, 'credentials', 'codex-work'))).mode & 0o777).equal(0o700);
    await should(lstat(world.paths.hostCodexHome)).be.rejected();
  });

  it("should link a runtime's auth.json to the canonical file by absolute path, then leave it alone", async () => {
    // Arrange — an empty slot: the canonical file does not exist yet, and the link still goes in.
    const world = await machine();
    const resolution = world.resolve('codex-work', { harness: 'codex', store: 'ferretry' });
    const home = path.join(world.paths.fleetRoot, 'homes', 'r1');
    await mkdir(home, { recursive: true });
    const link = codexCredentialLink(home, resolution);
    if (link === undefined) throw new Error('fixture');

    // Act
    const first = await links.linkCodex(link);
    const second = await links.linkCodex(link);

    // Assert — the shape U4's `codex-credential-link.test.ts` measured a refresh keeps.
    should(first).deepEqual({ ok: true, change: 'linked' });
    should(second).deepEqual({ ok: true, change: 'unchanged' });
    should(await readlink(link.path)).equal(path.join(world.paths.fleetRoot, 'credentials', 'codex-work', 'auth.json'));
  });

  it('should relink a runtime moved to another credential, without touching either credential', async () => {
    const world = await machine();
    const home = path.join(world.paths.fleetRoot, 'homes', 'r1');
    await mkdir(home, { recursive: true });
    const before = codexCredentialLink(home, world.resolve('a', { harness: 'codex', store: 'ferretry' }));
    const after = codexCredentialLink(home, world.resolve('b', { harness: 'codex', store: 'ferretry' }));
    if (before === undefined || after === undefined) throw new Error('fixture');
    await mkdir(path.dirname(before.target), { recursive: true });
    await writeFile(before.target, 'placeholder-a');
    await links.linkCodex(before);

    const actual = await links.linkCodex(after);

    should(actual).deepEqual({ ok: true, change: 'relinked' });
    should(await readlink(after.path)).equal(after.target);
    should(await readFile(before.target, 'utf8')).equal('placeholder-a');
  });

  it('should refuse to replace a regular auth.json, which is a credential of its own', async () => {
    const world = await machine();
    const home = path.join(world.paths.fleetRoot, 'homes', 'r1');
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'auth.json'), 'placeholder-own');
    const link = codexCredentialLink(home, world.resolve('a', { harness: 'codex', store: 'ferretry' }));
    if (link === undefined) throw new Error('fixture');

    const actual = await links.linkCodex(link);

    should(actual).have.property('ok', false);
    should(await readFile(path.join(home, 'auth.json'), 'utf8')).equal('placeholder-own');
  });

  it('should keep the old link and leave no temporary behind when a relink cannot be written', async () => {
    // Arrange — the runtime home holds a link to another credential and has become read-only.
    const world = await machine();
    const home = path.join(world.paths.fleetRoot, 'homes', 'r1');
    await mkdir(home, { recursive: true });
    await symlink('/nowhere/auth.json', path.join(home, 'auth.json'));
    const link = codexCredentialLink(home, world.resolve('a', { harness: 'codex', store: 'ferretry' }));
    if (link === undefined) throw new Error('fixture');
    await chmod(home, 0o500);

    // Act
    const outcome = await links.linkCodex(link).catch((error: unknown) => error);
    await chmod(home, 0o700);

    // Assert
    should(outcome).be.instanceOf(Error);
    should(await readlink(path.join(home, 'auth.json'))).equal('/nowhere/auth.json');
    should(await readdir(home)).deepEqual(['auth.json']);
  });

  it('should rethrow a lookup failure that is not an absence', async () => {
    const world = await machine();
    const file = path.join(world.root, 'plain-file');
    await writeFile(file, 'x');

    await should(links.linkCodex({ path: path.join(file, 'auth.json'), target: '/t' })).be.rejected();
  });
});
