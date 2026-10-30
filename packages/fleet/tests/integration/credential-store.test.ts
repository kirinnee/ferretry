/**
 * The credential store against a real filesystem and a scripted `security`.
 *
 * Every path here is inside a temporary directory this test created. Nothing reads the invoking user's
 * homes, keychain or fleet state, and the macOS branch is driven through the injected command seam so
 * it is exercised on a host that is not macOS — which is the only way it gets tested at all.
 */
import { afterEach, describe, it } from 'bun:test';
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  DEFAULT_KEYCHAIN_SERVICE,
  FALLBACK_KEYCHAIN_ACCOUNT,
  harnessKeychainAccount,
  KEYCHAIN_INTERACTIVE_LINE_LIMIT,
  KEYCHAIN_ITEM_NOT_FOUND,
  keychainService,
  keychainServices,
  keychainWriteLine,
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
  /** What each invocation was handed on standard input, by the same index as `calls`. */
  readonly inputs: (string | undefined)[] = [];

  constructor(private readonly replies: readonly CredentialCommandResult[]) {}

  run(command: readonly [string, ...string[]], _timeoutMs: number, stdin?: string): Promise<CredentialCommandResult> {
    this.calls.push([...command]);
    this.inputs.push(stdin);
    return Promise.resolve(this.replies[this.calls.length - 1] ?? { code: 0, stdout: '' });
  }
}

/** The item a scripted `security -i` write named, and the material it carried, parsed from its input. */
const writtenItem = (line: string | undefined): { account: string; service: string; blob: string } => {
  const match = /^add-generic-password -U -a "([^"]*)" -s "([^"]*)" -X ([0-9a-f]+)\n$/u.exec(line ?? '');
  if (match === null) throw new Error(`not a keychain write: ${String(line)}`);
  return { account: match[1]!, service: match[2]!, blob: Buffer.from(match[3]!, 'hex').toString('utf8') };
};

/** A read-back that answers with the material that was just written. */
const readBack = (blob: string): CredentialCommandResult => ({ code: 0, stdout: `${blob}\n` });

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

  it('should hand the child its standard input and close it', async () => {
    // Act — `cat` only exits once its input is closed, so this also proves the close.
    const actual = await new SpawnCredentialCommand().run(['/bin/cat'], 5_000, 'placeholder-input');

    // Assert
    should(actual).deepEqual({ code: 0, stdout: 'placeholder-input' });
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

  it.each([
    ['is not JSON', '{ "projects": { "/work": { "hasTrustDialogAccepted": true } }'],
    ['is JSON but not an object', '["placeholder"]'],
  ])('should leave a target harness config that %s byte for byte', async (_label, existing) => {
    // Arrange — that file holds the harness's projects, trust decisions and MCP servers. Merging into
    // what could not be read used to replace ALL of it with `{ oauthAccount }`.
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    await writeFile(claudeFilePath(donorHome), claudeBlob(NOW + HOUR));
    await writeFile(claudeConfigPath(donorHome), JSON.stringify({ oauthAccount: { emailAddress: 'placeholder' } }));
    await writeFile(claudeConfigPath(targetHome), existing);

    // Act
    const actual = await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'));

    // Assert — the credential still landed; only the display name was given up.
    should(actual).deepEqual({ ok: true });
    should(await readFile(claudeConfigPath(targetHome), 'utf8')).equal(existing);
    should(await readFile(claudeFilePath(targetHome), 'utf8')).equal(claudeBlob(NOW + HOUR));
  });

  it.each([
    ['claude', claudeFilePath],
    ['codex', codexPath],
  ] as const)('should refuse to write a %s credential through a symbolic link', async (kind, locate) => {
    // Arrange — a home whose credential file is linked to somebody's own login.
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    const linked = path.join(await temporaryDirectory(), 'linked-credential');
    const blob =
      kind === 'claude' ? claudeBlob(NOW + HOUR) : JSON.stringify({ tokens: { refresh_token: 'placeholder-refresh' } });
    await writeFile(locate(donorHome), blob);
    await writeFile(linked, 'untouched');
    await symlink(linked, locate(targetHome));

    // Act / Assert — the throw becomes a refusal naming the link, one layer up.
    await fileStore()
      .clone(kind, member(donorHome), member(targetHome, 'account-two'))
      .should.be.rejectedWith(/is a symbolic link/u);
    should(await readFile(linked, 'utf8')).equal('untouched');
  });

  it('should surface a failure to inspect the credential file other than its being absent', async () => {
    // Arrange — a target "home" that is really a file, so the credential path under it cannot be
    // looked at: an unreadable destination is a refusal to write, never mistaken for a missing one.
    const donorHome = await temporaryDirectory();
    const notAHome = path.join(await temporaryDirectory(), 'not-a-home');
    const blob = JSON.stringify({ tokens: { refresh_token: 'placeholder-refresh' } });
    await writeFile(codexPath(donorHome), blob);
    await writeFile(notAHome, 'a file where a home should be');

    // Act / Assert
    await fileStore()
      .clone('codex', member(donorHome), member(notAHome, 'account-two'))
      .should.be.rejectedWith(/ENOTDIR/u);
    should(await readFile(notAHome, 'utf8')).equal('a file where a home should be');
  });

  it('should replace the credential file rather than rewrite it in place', async () => {
    // Arrange — a second name for the target's credential file. An in-place truncate-and-write is
    // visible under both names, and a crash part-way leaves a truncated credential under both.
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    const otherName = path.join(await temporaryDirectory(), 'other-name');
    await writeFile(claudeFilePath(donorHome), claudeBlob(NOW + HOUR));
    await writeFile(claudeFilePath(targetHome), 'previous', { mode: 0o644 });
    await link(claudeFilePath(targetHome), otherName);

    // Act
    const actual = await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'));

    // Assert — a new file at the name, owner-only, with no temporary file left beside it.
    should(actual).deepEqual({ ok: true });
    should(await readFile(claudeFilePath(targetHome), 'utf8')).equal(claudeBlob(NOW + HOUR));
    should(await readFile(otherName, 'utf8')).equal('previous');
    should((await stat(claudeFilePath(targetHome))).mode & 0o777).equal(0o600);
    should((await readdir(targetHome)).filter(name => name.endsWith('.tmp'))).be.empty();
  });

  it('should leave the target harness config alone when it is a symbolic link', async () => {
    // Arrange
    const donorHome = await temporaryDirectory();
    const targetHome = await temporaryDirectory();
    const linked = path.join(await temporaryDirectory(), 'linked-config.json');
    await writeFile(claudeFilePath(donorHome), claudeBlob(NOW + HOUR));
    await writeFile(claudeConfigPath(donorHome), JSON.stringify({ oauthAccount: { emailAddress: 'placeholder' } }));
    await writeFile(linked, JSON.stringify({ theme: 'dark' }));
    await symlink(linked, claudeConfigPath(targetHome));

    // Act
    const actual = await fileStore().clone('claude', member(donorHome), member(targetHome, 'account-two'));

    // Assert
    should(actual).deepEqual({ ok: true });
    should(await readFile(linked, 'utf8')).equal(JSON.stringify({ theme: 'dark' }));
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
 * The `acct` attribute an item is stored under.
 *
 * `security add-generic-password -U` matches on the PAIR (`acct`, `svce`), so an empty `acct` adds
 * a second item beside the harness's instead of updating it — after which an `-s`-only read can
 * return either. The composition roots used to pass `USER ?? ''`.
 */
describe('harnessKeychainAccount', () => {
  it('should take the first candidate that names somebody', () => {
    should(harnessKeychainAccount([undefined, '  ', 'placeholder-user', 'placeholder-other'])).equal(
      'placeholder-user',
    );
  });

  it('should never be empty, and should agree with the harness when nothing names anybody', () => {
    // Assert — `claude-code-user` is the harness's own last resort, spelled the same way.
    should(harnessKeychainAccount([undefined, ''])).equal(FALLBACK_KEYCHAIN_ACCOUNT);
    should(FALLBACK_KEYCHAIN_ACCOUNT).equal('claude-code-user');
  });
});

describe('keychainWriteLine', () => {
  it('should carry the material hex-encoded, so nothing in it is ever quoted', () => {
    // Act
    const actual = keychainWriteLine('placeholder-user', 'Claude Code-credentials', 'a "b" \\ c');

    // Assert
    should(actual).equal(
      `add-generic-password -U -a "placeholder-user" -s "Claude Code-credentials" -X ${Buffer.from('a "b" \\ c').toString('hex')}\n`,
    );
  });

  it.each([
    ['an account holding a quote', 'odd"name', 'Claude Code-credentials'],
    ['an account holding a backslash', 'odd\\name', 'Claude Code-credentials'],
    ['a service holding a line break', 'placeholder-user', 'Claude\nCode'],
    ['an empty account', '', 'Claude Code-credentials'],
  ])('should refuse %s rather than escape it', (_label, account, service) => {
    should(keychainWriteLine(account, service, 'placeholder')).be.undefined();
  });

  it('should refuse a line its reader could cut short, rather than store a truncated credential', () => {
    // Arrange — hex doubles the material, so half the limit is already over it.
    const blob = 'x'.repeat(KEYCHAIN_INTERACTIVE_LINE_LIMIT / 2);

    // Act / Assert
    should(keychainWriteLine('placeholder-user', 'Claude Code-credentials', blob)).be.undefined();
    should(keychainWriteLine('placeholder-user', 'Claude Code-credentials', 'x'.repeat(1_000))).be.a.String();
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
      readBack(claudeBlob(NOW + HOUR)),
    ]);

    // Act
    const actual = await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert — the write goes through `security -i` on stdin, then is proved by reading the same pair.
    should(actual).deepEqual({ ok: true });
    should(command.calls[2]).deepEqual(['security', '-i']);
    should(writtenItem(command.inputs[2])).deepEqual({
      account: 'existing-account',
      service: keychainService('/homes/target'),
      blob: claudeBlob(NOW + HOUR),
    });
    should(command.calls[3]).deepEqual([
      'security',
      'find-generic-password',
      '-a',
      'existing-account',
      '-s',
      keychainService('/homes/target'),
      '-w',
    ]);
  });

  it('should never put the credential in any argument list', async () => {
    // Arrange — every argv is visible to every local process through `ps` while the command runs.
    const blob = claudeBlob(NOW + HOUR);
    const { store, command } = macStore([
      { code: 0, stdout: blob },
      { code: 0, stdout: '"acct"<blob>="existing-account"' },
      { code: 0, stdout: '' },
      readBack(blob),
    ]);

    // Act
    const actual = await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert — neither the material nor its hex spelling appears in any command line.
    should(actual).deepEqual({ ok: true });
    const hex = Buffer.from(blob, 'utf8').toString('hex');
    for (const argv of command.calls) {
      should(argv.some(argument => argument.includes('placeholder-access') || argument.includes(hex))).be.false();
    }
  });

  it('should refuse a write whose read-back does not hold what was written', async () => {
    // Arrange — `security -i` exits 0 even when the command it ran failed, so the read decides.
    const { store } = macStore([
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: 0, stdout: '"acct"<blob>="existing-account"' },
      { code: 0, stdout: '' },
      { code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' },
    ]);

    // Act
    const actual = await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'the keychain write could not be confirmed (exit 44)' });
  });

  it('should refuse a write whose read-back holds a different credential', async () => {
    // Arrange
    const { store } = macStore([
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: 0, stdout: '"acct"<blob>="existing-account"' },
      { code: 0, stdout: '' },
      readBack(claudeBlob(NOW + 2 * HOUR)),
    ]);

    // Act / Assert
    should(await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'))).deepEqual({
      ok: false,
      reason: 'the keychain write could not be confirmed (exit 0)',
    });
  });

  it('should refuse a write it could not make without exposing the credential', async () => {
    // Arrange — an `acct` holding a quote cannot be carried literally, so nothing is run at all.
    const command = new ScriptedCommand([
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' },
    ]);
    const store = new PlatformFleetCredentialStore({
      platform: 'darwin',
      command,
      now: () => NOW,
      keychainAccount: 'odd"name',
    });

    // Act
    const actual = await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert
    should(actual).deepEqual({
      ok: false,
      reason: 'the keychain write was refused, because it could not be made without exposing the credential',
    });
    should(command.calls).have.length(2);
  });

  it('should fall back to the supplied account when the target item names none', async () => {
    // Arrange
    const { store, command } = macStore([
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' },
      { code: 0, stdout: '' },
      readBack(claudeBlob(NOW + HOUR)),
    ]);

    // Act
    await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert
    should(writtenItem(command.inputs[2]).account).equal('placeholder-user');
  });

  it('should fall back to the supplied account when the attribute output has no acct', async () => {
    // Arrange
    const { store, command } = macStore([
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: 0, stdout: '"svce"<blob>="Claude Code-credentials-abc"' },
      { code: 0, stdout: '' },
      readBack(claudeBlob(NOW + HOUR)),
    ]);

    // Act
    await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert
    should(writtenItem(command.inputs[2]).account).equal('placeholder-user');
  });

  it('should fall back to the supplied account when the item names an empty one', async () => {
    // Arrange
    const { store, command } = macStore([
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: 0, stdout: '"acct"<blob>=""' },
      { code: 0, stdout: '' },
      readBack(claudeBlob(NOW + HOUR)),
    ]);

    // Act
    await store.clone('claude', member('/homes/donor'), member('/homes/target', 'account-two'));

    // Assert
    should(writtenItem(command.inputs[2]).account).equal('placeholder-user');
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

  it('should write the default home to the unsuffixed item it is already stored under', async () => {
    // Arrange — read donor, look up the suffixed item (absent), look up the bare item (present).
    const { store, command } = defaultHomeStore([
      { code: 0, stdout: claudeBlob(NOW + HOUR) },
      { code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' },
      { code: 0, stdout: '"acct"<blob>="existing-account"' },
      { code: 0, stdout: '' },
      readBack(claudeBlob(NOW + HOUR)),
    ]);

    // Act
    const actual = await store.clone('claude', member('/homes/donor'), member('/user/.claude', 'account-two'));

    // Assert — a write to the suffixed name would add an item the harness never reads.
    should(actual).deepEqual({ ok: true });
    should(writtenItem(command.inputs[3])).containDeep({
      service: DEFAULT_KEYCHAIN_SERVICE,
      account: 'existing-account',
    });
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

/**
 * The write line against the real `security`, which only a Mac has.
 *
 * Everything above drives a scripted command, so it proves what this store HANDS `security` and
 * nothing about whether `security -i` parses it. This does, against a throwaway keychain file, so the
 * user's own keychains are never touched; the keychain path is the one word the store does not add.
 */
describe.skipIf(process.platform !== 'darwin')('keychainWriteLine against the real security command', () => {
  it('should store the material through standard input and read it back unchanged', async () => {
    // Arrange
    const keychain = path.join(await temporaryDirectory(), 'fy-test.keychain-db');
    const command = new SpawnCredentialCommand();
    const service = 'Claude Code-credentials-fytest';
    const blob = claudeBlob(NOW + HOUR);
    should((await command.run(['security', 'create-keychain', '-p', 'placeholder', keychain], 10_000)).code).equal(0);

    try {
      // Act
      const line = keychainWriteLine('placeholder-user', service, blob) ?? '';
      const written = await command.run(['security', '-i'], 10_000, `${line.trimEnd()} "${keychain}"\n`);
      const read = await command.run(
        ['security', 'find-generic-password', '-a', 'placeholder-user', '-s', service, '-w', keychain],
        10_000,
      );

      // Assert
      should(written.code).equal(0);
      should({ code: read.code, stdout: read.stdout.trim() }).deepEqual({ code: 0, stdout: blob });
    } finally {
      await command.run(['security', 'delete-keychain', keychain], 10_000);
    }
  });
});
