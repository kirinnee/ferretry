/**
 * Reading a Claude login on macOS exactly where Claude Code itself reads it — the read a sign-in's
 * post-check makes, and the one that said "no usable login was written" on a Mac where Claude had
 * just written one.
 *
 * Two facts have to agree with the harness, and each is pinned here against a TRANSCRIPTION of the
 * harness's own code, per version, rather than against a restatement of it:
 *
 * - the keychain item's `svce`, from `CLAUDE_SECURESTORAGE_CONFIG_DIR` (and `CLAUDE_CONFIG_DIR` when it
 *   is unset);
 * - its `acct`: `$USER`, else the OS login name — the one a daemon under launchd, with no `USER`, has
 *   to get right, because Claude reads and writes its item by the pair.
 *
 * Then the read itself, through the command seam: the keychain first, the storage directory's file on
 * absence AND on `security` exit 36 (Claude's own fallback), and a trail of every place looked in that
 * names locations and never a value. The keychain is scripted; nothing here touches a real one.
 */
import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import {
  COMMAND_FAILED,
  type CredentialCommand,
  type CredentialCommandResult,
  claudeKeychainAccount,
  DEFAULT_KEYCHAIN_SERVICE,
  FALLBACK_KEYCHAIN_ACCOUNT,
  KEYCHAIN_INTERACTION_NOT_ALLOWED,
  KEYCHAIN_ITEM_NOT_FOUND,
  keychainReadFailure,
  PlatformFleetCredentialStore,
  secureStorageKeychainService,
} from '../../src/adapters/credential-store.ts';
import { resolveCredentialStore, type StoredCredentialResolution } from '../../src/lib/account/credentials.ts';
import { CredentialSchema } from '../../src/lib/account/schema.ts';
import { storeInspectionWords } from '../../src/lib/account/store-inspection.ts';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const claudeBlob = (expiresAt: number): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken: 'placeholder-access', refreshToken: 'placeholder-refresh', expiresAt },
  });

// ── The harness's own derivations, transcribed per version ───────────────────────────────────────

/** What one Claude Code build's naming functions read: its environment, its home and its login name. */
interface HarnessHost {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
  /** `os.userInfo().username`, or a throw — which `os.userInfo()` does for a uid with no passwd entry. */
  readonly username: () => string;
}

/**
 * One measured build: the keychain service and account functions, transcribed from the shipped bundle
 * with only their names spelled out. The two builds read are the Linux 2.1.281 binary (`iLe`, `Q4`) and
 * the npm `@anthropic-ai/claude-code-darwin-arm64@2.1.303` binary (`D1`, `Vx`) — the macOS build, which
 * is the one a Homebrew cask installs. Both are byte-for-byte the same logic, which is itself the
 * finding: nothing in the naming moved between them.
 *
 * `configDirectory` is Claude's own config-dir resolution (`CLAUDE_CONFIG_DIR` else `~/.claude`, NFC).
 */
interface HarnessBuild {
  readonly version: string;
  service(host: HarnessHost): string;
  account(host: HarnessHost): string;
}

const configDirectory = (host: HarnessHost): string =>
  (host.env.CLAUDE_CONFIG_DIR ?? path.join(host.homedir, '.claude')).normalize('NFC');

/** `function iLe(n=""){let e=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,t=e!==void 0?!e:!process.env.CLAUDE_CONFIG_DIR,…` */
function transcribedService(host: HarnessHost, oauthFileSuffix = '', suffix = '-credentials'): string {
  const secure = host.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const bare = secure !== undefined ? !secure : !host.env.CLAUDE_CONFIG_DIR;
  const hashed = secure !== undefined ? secure.normalize('NFC') : configDirectory(host);
  const hash = bare ? '' : `-${createHash('sha256').update(hashed).digest('hex').substring(0, 8)}`;
  return `Claude Code${oauthFileSuffix}${suffix}${hash}`;
}

/** `function Q4(){let n;try{n=process.env.USER||u().username}catch{n="claude-code-user"}if(!s.test(n))return"claude-code-user";return n}` */
function transcribedAccount(host: HarnessHost): string {
  let named: string;
  try {
    named = host.env.USER || host.username();
  } catch {
    named = 'claude-code-user';
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(named)) return 'claude-code-user';
  return named;
}

const BUILDS: readonly HarnessBuild[] = [
  { version: '2.1.281 (linux bundle)', service: host => transcribedService(host), account: transcribedAccount },
  { version: '2.1.303 (darwin-arm64)', service: host => transcribedService(host), account: transcribedAccount },
];

const HOME = '/Users/sam';

/** Hosts a daemon can find itself on, each with the reason it is here. */
const HOSTS: readonly { readonly name: string; readonly host: HarnessHost }[] = [
  { name: 'a terminal', host: { env: { USER: 'sam' }, homedir: HOME, username: () => 'sam' } },
  // launchd and systemd hand a service a bare environment: no USER, no LOGNAME.
  { name: 'a launchd job with no USER', host: { env: {}, homedir: HOME, username: () => 'sam' } },
  { name: 'an empty USER', host: { env: { USER: '' }, homedir: HOME, username: () => 'sam' } },
  { name: 'a USER Claude refuses', host: { env: { USER: 'sam smith' }, homedir: HOME, username: () => 'sam' } },
  {
    name: 'a uid with no passwd entry',
    host: {
      env: {},
      homedir: HOME,
      username: () => {
        throw new Error('ENOENT');
      },
    },
  },
];

/** The secure-storage values a sign-in exports: the person's own login, a Ferretry store, an NFD one. */
const SECURE_STORAGE: readonly string[] = [
  '',
  '/Users/sam/.local/share/ferretry/fleet/credentials/claude-work',
  '/Users/sam/fleet/credentials/café',
];

describe('the keychain item Claude reads, per measured build', () => {
  for (const build of BUILDS) {
    for (const { name, host } of HOSTS) {
      it(`should name the same acct as claude-code ${build.version} on ${name}`, () => {
        // Act
        const actual = claudeKeychainAccount(host.env.USER, host.username);

        // Assert
        should(actual).equal(build.account(host));
      });
    }

    for (const secureStorage of SECURE_STORAGE) {
      it(`should name the same svce as claude-code ${build.version} for ${JSON.stringify(secureStorage)}`, () => {
        // Arrange — the sign-in exports both; Claude ignores CLAUDE_CONFIG_DIR once the store is named.
        const host: HarnessHost = {
          env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorage, CLAUDE_CONFIG_DIR: `${secureStorage}/sign-in` },
          homedir: HOME,
          username: () => 'sam',
        };

        // Act / Assert
        should(secureStorageKeychainService(secureStorage)).equal(build.service(host));
      });
    }
  }

  it('should name the real login for a daemon with no USER, where LOGNAME would have named nobody', () => {
    // The value the composition root used to pass: USER, then LOGNAME, then Claude's last resort.
    should(claudeKeychainAccount(undefined, () => 'sam')).equal('sam');
    should(claudeKeychainAccount(undefined, () => 'sam')).not.equal(FALLBACK_KEYCHAIN_ACCOUNT);
  });
});

// ── The read, with its trail ──────────────────────────────────────────────────────────────────────

/** A `security` that answers one scripted reply per call, recording every call. */
class ScriptedSecurity implements CredentialCommand {
  readonly calls: string[][] = [];

  constructor(private readonly replies: readonly CredentialCommandResult[]) {}

  run(command: readonly [string, ...string[]]): Promise<CredentialCommandResult> {
    this.calls.push([...command]);
    return Promise.resolve(this.replies[this.calls.length - 1] ?? { code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' });
  }
}

const mac = (replies: readonly CredentialCommandResult[]) =>
  new PlatformFleetCredentialStore({
    platform: 'darwin',
    command: new ScriptedSecurity(replies),
    now: () => NOW,
    keychainAccount: 'sam',
  });

/** A `store: ferretry` Claude credential and a `host` one, rooted in a temporary machine. */
async function machine() {
  const root = await mkdtemp(path.join(tmpdir(), 'fy-fleet-macos-signin-test-'));
  temporaryDirectories.push(root);
  const paths = { fleetRoot: path.join(root, 'fy', 'fleet'), userHome: path.join(root, 'user') };
  const resolve = (id: string, input: Record<string, unknown>) =>
    resolveCredentialStore(id, CredentialSchema.parse(input), paths) as StoredCredentialResolution & {
      harness: 'claude';
      credentialFile: string;
      storageDirectory: string;
      secureStorage: string;
    };
  return { root, resolve };
}

const itemLocation = (secureStorage: string): string =>
  `the keychain item "${secureStorageKeychainService(secureStorage)}" (account "sam")`;

describe('reading a Claude login on macOS for a sign-in', () => {
  it('should report the item and the file it looked in, and that both were empty', async () => {
    // Arrange
    const world = await machine();
    const resolution = world.resolve('claude-you', { harness: 'claude', store: 'host' });

    // Act
    const actual = await mac([{ code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' }]).inspectStored(resolution);

    // Assert
    should(actual).deepEqual({
      reading: { state: 'missing' },
      checked: [
        { location: `the keychain item "${DEFAULT_KEYCHAIN_SERVICE}" (account "sam")`, found: 'nothing' },
        { location: `the file ${resolution.credentialFile}`, found: 'nothing' },
      ],
    });
    should(storeInspectionWords(actual)).equal(
      `Checked the keychain item "${DEFAULT_KEYCHAIN_SERVICE}" (account "sam") — nothing there; then the file ${resolution.credentialFile} — nothing there.`,
    );
  });

  it('should find the login in the item and stop there', async () => {
    // Arrange
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });

    // Act
    const actual = await mac([{ code: 0, stdout: `${claudeBlob(NOW + HOUR)}\n` }]).inspectStored(resolution);

    // Assert
    should(actual).deepEqual({
      reading: { state: 'valid', expiresAt: NOW + HOUR },
      checked: [{ location: itemLocation(resolution.secureStorage), found: 'present' }],
    });
  });

  it('should read the file Claude falls back to when the keychain will not answer a background read', async () => {
    // Arrange — exit 36: what launchd's daemon gets from a locked keychain, and where Claude writes instead.
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });
    await mkdir(resolution.storageDirectory, { recursive: true });
    await writeFile(resolution.credentialFile, claudeBlob(NOW + HOUR));
    const store = mac([{ code: KEYCHAIN_INTERACTION_NOT_ALLOWED, stdout: '' }]);

    // Act
    const actual = await store.inspectStored(resolution);

    // Assert
    should(actual).deepEqual({
      reading: { state: 'valid', expiresAt: NOW + HOUR },
      checked: [
        {
          location: itemLocation(resolution.secureStorage),
          found: 'unreadable',
          why: keychainReadFailure(KEYCHAIN_INTERACTION_NOT_ALLOWED),
        },
        { location: `the file ${resolution.credentialFile}`, found: 'present' },
      ],
    });
  });

  it('should keep a locked keychain with no file unreadable, saying it was locked', async () => {
    // Arrange
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });

    // Act
    const actual = await mac([{ code: KEYCHAIN_INTERACTION_NOT_ALLOWED, stdout: '' }]).storedMaterial(resolution);

    // Assert
    should(actual).deepEqual({
      outcome: 'unreadable',
      reason: keychainReadFailure(KEYCHAIN_INTERACTION_NOT_ALLOWED),
    });
  });

  it('should stop at a keychain that refused the read, and say so', async () => {
    // Arrange — a usable file beside it must not answer for an item whose access list said no.
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });
    await mkdir(resolution.storageDirectory, { recursive: true });
    await writeFile(resolution.credentialFile, claudeBlob(NOW + HOUR));

    // Act
    const actual = await mac([{ code: 51, stdout: '' }]).inspectStored(resolution);

    // Assert
    should(actual.reading).have.property('state', 'unreadable');
    should(actual.checked).deepEqual([
      { location: itemLocation(resolution.secureStorage), found: 'unreadable', why: keychainReadFailure(51) },
    ]);
    should(storeInspectionWords(actual)).match(/access list does not allow it \(security exit 51\)/u);
  });

  it('should say a login it found cannot be used, and why, without its contents', async () => {
    // Arrange — expired, and nothing to renew it with.
    const world = await machine();
    const resolution = world.resolve('claude-you', { harness: 'claude', store: 'host' });
    const dead = JSON.stringify({ claudeAiOauth: { accessToken: 'placeholder-access', expiresAt: NOW - HOUR } });

    // Act
    const actual = await mac([{ code: 0, stdout: dead }]).inspectStored(resolution);

    // Assert
    const words = storeInspectionWords(actual);
    should(words).equal(
      `Checked the keychain item "${DEFAULT_KEYCHAIN_SERVICE}" (account "sam") — a login is there, but it cannot be used: it has expired and holds no refresh token to renew it.`,
    );
    should(words).not.match(/placeholder-access/u);
  });

  it('should record a file it could not open, and keep the trail up to it', async () => {
    // Arrange — the storage directory unreadable to this user.
    const world = await machine();
    const resolution = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });
    await mkdir(resolution.storageDirectory, { recursive: true });
    await writeFile(resolution.credentialFile, claudeBlob(NOW + HOUR));
    await chmod(resolution.credentialFile, 0o000);
    const root = process.getuid?.() === 0;

    // Act
    const actual = await mac([{ code: KEYCHAIN_ITEM_NOT_FOUND, stdout: '' }]).inspectStored(resolution);

    // Assert — root reads anything, so the file is then simply found.
    if (root) should(actual.reading).have.property('state', 'valid');
    else {
      should(actual).deepEqual({
        reading: { state: 'unreadable', reason: 'the file could not be read (EACCES)' },
        checked: [
          { location: itemLocation(resolution.secureStorage), found: 'nothing' },
          {
            location: `the file ${resolution.credentialFile}`,
            found: 'unreadable',
            why: 'the file could not be read (EACCES)',
          },
        ],
      });
    }
  });

  it('should look only at the file on Linux, and at the canonical file for Codex', async () => {
    // Arrange
    const world = await machine();
    const claude = world.resolve('claude-work', { harness: 'claude', store: 'ferretry' });
    const codex = resolveCredentialStore(
      'codex-work',
      CredentialSchema.parse({ harness: 'codex', store: 'ferretry' }),
      { fleetRoot: path.join(world.root, 'fy', 'fleet'), userHome: path.join(world.root, 'user') },
    ) as StoredCredentialResolution & { canonicalFile: string };
    const linux = new PlatformFleetCredentialStore({
      platform: 'linux',
      command: new ScriptedSecurity([]),
      now: () => NOW,
      keychainAccount: 'sam',
    });

    // Act
    const [onLinux, ofCodex] = await Promise.all([linux.inspectStored(claude), mac([]).inspectStored(codex)]);

    // Assert
    should(onLinux.checked).deepEqual([{ location: `the file ${claude.credentialFile}`, found: 'nothing' }]);
    should(ofCodex.checked).deepEqual([{ location: `the file ${codex.canonicalFile}`, found: 'nothing' }]);
  });
});

describe('keychainReadFailure', () => {
  const cases: readonly [number, RegExp][] = [
    [COMMAND_FAILED, /could not be run, or did not answer in time/u],
    [KEYCHAIN_INTERACTION_NOT_ALLOWED, /locked, or reading it needs an approval .*\(security exit 36\)/u],
    [37, /no keychain the daemon can open \(security exit 37\)/u],
    [50, /no keychain the daemon can open \(security exit 50\)/u],
    [53, /no keychain the daemon can open \(security exit 53\)/u],
    [51, /refused this read.*\(security exit 51\)/u],
    [128, /denied or dismissed \(security exit 128\)/u],
    [1, /^the keychain read failed \(security exit 1\)$/u],
  ];
  for (const [code, words] of cases) {
    it(`should name security exit ${String(code)}`, () => {
      should(keychainReadFailure(code)).match(words);
    });
  }
});
