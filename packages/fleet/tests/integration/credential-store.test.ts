/**
 * The credential store against a real filesystem and a scripted `security`.
 *
 * Every path here is inside a temporary directory this test created. Nothing reads the invoking user's
 * homes, keychain or fleet state, and the macOS branch is driven through the injected command seam so
 * it is exercised on a host that is not macOS — which is the only way it gets tested at all.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import {
  COMMAND_FAILED,
  type CredentialCommand,
  type CredentialCommandResult,
  claudeFilePath,
  claudeKeychainAccount,
  codexPath,
  DEFAULT_KEYCHAIN_SERVICE,
  FALLBACK_KEYCHAIN_ACCOUNT,
  KEYCHAIN_ITEM_NOT_FOUND,
  keychainService,
  keychainServices,
  PlatformFleetCredentialStore,
  SpawnCredentialCommand,
} from '../../src/adapters/credential-store.ts';
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

  run(command: readonly [string, ...string[]], _timeoutMs: number): Promise<CredentialCommandResult> {
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

    // Act
    const actual = await new SpawnCredentialCommand().run([shell, '-c', 'sleep 30'], 100);

    // Assert — the bound is honoured whether or not the pipe ever closes.
    should(actual).deepEqual({ code: COMMAND_FAILED, stdout: '' });
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

describe('keychainService', () => {
  it('should derive the item name Claude Code derives from a config directory', () => {
    // Assert — the suffix is the first eight hex digits of sha256 of the exact home path.
    should(keychainService('/homes/claude-kirin')).match(/^Claude Code-credentials-[0-9a-f]{8}$/u);
  });

  it('should give two different homes two different items', () => {
    should(keychainService('/homes/one')).not.equal(keychainService('/homes/two'));
  });
});

/**
 * The names one home's credential could be stored under.
 *
 * Read out of the harness's own source rather than guessed: `claude-code` builds the item name as
 * `Claude Code${OAUTH_FILE_SUFFIX}-credentials${suffix}` where `suffix` is
 * `-sha256(configDir).slice(0,8)` **only when `CLAUDE_CONFIG_DIR` is set** and `OAUTH_FILE_SUFFIX`
 * is empty in the production configuration. So a default install stores its login under the bare
 * name, and asking for a suffixed item there asks for one that was never written.
 */
describe('keychainServices', () => {
  it('should offer one name for a home the harness reaches through CLAUDE_CONFIG_DIR', () => {
    // Assert — the operator's own login must never answer for a fleet account that has none.
    should(keychainServices('/homes/claude-default', '/user/.claude')).deepEqual([
      keychainService('/homes/claude-default'),
    ]);
  });

  it('should offer the unsuffixed name for the default home, after the suffixed one', () => {
    // Assert — an operator who exports CLAUDE_CONFIG_DIR at their own default home makes the
    // suffixed item the real one, so it still has to win; the bare name is the fallback.
    should(keychainServices('/user/.claude', '/user/.claude')).deepEqual([
      keychainService('/user/.claude'),
      DEFAULT_KEYCHAIN_SERVICE,
    ]);
  });

  it('should treat a trailing separator as the same home', () => {
    should(keychainServices('/user/.claude/', '/user/.claude')).containEql(DEFAULT_KEYCHAIN_SERVICE);
  });

  it('should offer one name when no default home was declared', () => {
    // Assert — the fail-closed reading: it can cost a seed its donor, never send a read elsewhere.
    should(keychainServices('/user/.claude')).deepEqual([keychainService('/user/.claude')]);
  });
});

/**
 * The `acct` attribute Claude Code looks its keychain item up by. It must never be empty, and a name
 * outside the harness's alphabet becomes the harness's own last resort.
 */
describe('claudeKeychainAccount', () => {
  it('should take $USER when it names somebody, before the OS login name', () => {
    should(claudeKeychainAccount('placeholder-user', () => 'placeholder-other')).equal('placeholder-user');
  });

  it('should take the OS login name when $USER is unset or empty', () => {
    should(claudeKeychainAccount(undefined, () => 'placeholder-other')).equal('placeholder-other');
    should(claudeKeychainAccount('', () => 'placeholder-other')).equal('placeholder-other');
  });

  it('should never be empty, and should agree with the harness when nothing names anybody', () => {
    // Assert — `claude-code-user` is the harness's own last resort, spelled the same way.
    should(
      claudeKeychainAccount(undefined, () => {
        throw new Error('no login name');
      }),
    ).equal(FALLBACK_KEYCHAIN_ACCOUNT);
    should(claudeKeychainAccount('has a space', () => 'placeholder-other')).equal(FALLBACK_KEYCHAIN_ACCOUNT);
    should(FALLBACK_KEYCHAIN_ACCOUNT).equal('claude-code-user');
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

  /**
   * THE REPORTED BUG, at the point it starts.
   *
   * The first run's donor is this host's own `~/.claude`, which is the one home the harness reaches
   * with no `CLAUDE_CONFIG_DIR` set — so its keychain item carries no suffix. Asking only for the
   * suffixed name asked for an item that does not exist, and a Mac that was signed in produced a
   * fleet that was not, with the boot reporting `no-donor` about a login on the same machine.
   */
  const defaultHomeStore = (replies: readonly CredentialCommandResult[], defaultClaudeHome = '/user/.claude') => {
    const command = new ScriptedCommand(replies);
    return {
      command,
      store: new PlatformFleetCredentialStore({
        platform: 'darwin',
        command,
        now: () => NOW,
        keychainAccount: 'placeholder-user',
        defaultClaudeHome,
        keychainTimeoutMs: 250,
      }),
    };
  };

  it('should find the default home credential under the unsuffixed item the harness wrote it to', async () => {
    // Arrange — the suffixed item does not exist, because the harness never wrote one.
    const { store, command } = defaultHomeStore([
      { code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' },
      { code: 0, stdout: `${claudeBlob(NOW + HOUR)}\n` },
    ]);

    // Act
    const actual = await store.read('claude', member('/user/.claude'));

    // Assert
    should(actual).deepEqual({ state: 'valid', expiresAt: NOW + HOUR });
    should(command.calls[0]?.[3]).equal(keychainService('/user/.claude'));
    should(command.calls[1]?.[3]).equal(DEFAULT_KEYCHAIN_SERVICE);
  });

  it('should never ask for the unsuffixed item on behalf of a configured home', async () => {
    // Arrange — the bare item is the OPERATOR's login. A fleet account reading it would report
    // itself signed in on somebody else's credential and then donate it to its siblings.
    const { store, command } = defaultHomeStore([{ code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' }]);

    // Act
    const actual = await store.read('claude', member('/homes/claude-default'));

    // Assert
    should(actual).deepEqual({ state: 'missing' });
    should(command.calls).have.length(1);
  });

  it('should stop at an item that exists but could not be read, rather than trying the next name', async () => {
    // Arrange — a locked keychain on this home's own item must not be answered from another one.
    const { store, command } = defaultHomeStore([{ code: 51, stdout: '' }]);

    // Act
    const actual = await store.read('claude', member('/user/.claude'));

    // Assert
    should(actual.state).equal('unreadable');
    should(command.calls).have.length(1);
  });

  /**
   * The harness's darwin store is `keychain-with-plaintext-fallback`: it reads the keychain and
   * falls back to `<home>/.credentials.json`, and it WRITES that file when the keychain write fails.
   * A store that looked only in the keychain reported `missing` — a hard negative — for a home that
   * is signed in.
   */
  it('should fall back to the credential file when the keychain has no item for this home', async () => {
    // Arrange
    const home = await temporaryDirectory();
    await writeFile(claudeFilePath(home), claudeBlob(NOW + HOUR));
    const { store } = defaultHomeStore([{ code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' }]);

    // Act
    const actual = await store.read('claude', member(home));

    // Assert
    should(actual).deepEqual({ state: 'valid', expiresAt: NOW + HOUR });
  });

  it('should not answer an unreadable keychain from the credential file beside it', async () => {
    // Arrange — the file may be the credential the harness already replaced, so "I could not tell"
    // must stay "I could not tell": an unreadable home is never overwritten, a missing one is.
    const home = await temporaryDirectory();
    await writeFile(claudeFilePath(home), claudeBlob(NOW + HOUR));
    const { store } = defaultHomeStore([{ code: 51, stdout: '' }]);

    // Act
    const actual = await store.read('claude', member(home));

    // Assert
    should(actual.state).equal('unreadable');
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
