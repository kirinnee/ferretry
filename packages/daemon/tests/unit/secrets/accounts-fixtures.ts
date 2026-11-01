import { TotpParametersSchema } from '@ferretry/protocol';
import {
  AccountDirectory,
  type AccountDirectoryOptions,
  AccountVault,
  type LoginIndexDocument,
  type SecretVaultDocument,
} from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments } from '../runtime/mounts/support.ts';

/** A version 1 saved-login store, as an older daemon left it, and a daemon booting over it. */

export const CLOCK = { now: () => '2026-10-31T09:00:00.000Z' };
const T = '2026-10-01T00:00:00.000Z';

export const GITHUB_PASSWORD = 'github-UNIQUE-password-1';
export const GOOGLE_PASSWORD = 'google-UNIQUE-password-2';
export const SUDO_PASSWORD = 'sudo-UNIQUE-password-3';
export const SEED = 'JBSWY3DPEHPK3PXP';

export const KEY = {
  GITHUB: 'L000000000000000000000001',
  GOOGLE: 'L000000000000000000000002',
  SITE: 'L000000000000000000000003',
  SUDO: 'L000000000000000000000004',
} as const;

export const SEAL = {
  githubPassword: `${KEY.GITHUB}_PASSWORD_0000000A`,
  githubSeed: `${KEY.GITHUB}_TOTP_0000000B`,
  googlePassword: `${KEY.GOOGLE}_PASSWORD_0000000C`,
  sudoPassword: `${KEY.SUDO}_PASSWORD_0000000D`,
  /** A value a stopped change left behind: no entry points at it. */
  orphan: `${KEY.GITHUB}_PASSWORD_0000000E`,
} as const;

const fact = (at: string) => ({ at, surface: 'page' as const, identity: '0123456789abcdef', since: T });

/**
 * GitHub (a website and an ssh host, a password and a 2FA seed, a recipe with auto-apply, a proposal, a fact seen on
 * its site and one seen on another page), Google (a provider that signs in on no site), a site that went via it, and
 * sudo on this machine.
 */
export function version1(): LoginIndexDocument {
  return {
    v: 1,
    entries: {
      GITHUB: {
        key: KEY.GITHUB,
        label: 'GitHub',
        match: ['github.com', 'ssh@build.example.com'],
        username: 'kirin',
        seals: { password: SEAL.githubPassword, totp: SEAL.githubSeed },
        totp: TotpParametersSchema.parse({}),
        recipe: 'Open github.com and sign in',
        autoApplyRecipe: true,
        observed: [fact('github.com'), fact('gitlab.com')],
        proposals: [
          {
            id: 'rp_0000000000000001',
            recipe: 'Open github.com/login',
            base: 'Open github.com and sign in',
            why: 'the page moved',
            sessionId: 'session-1',
            proposedAt: T,
          },
        ],
        createdAt: T,
        updatedAt: T,
      },
      GOOGLE: {
        key: KEY.GOOGLE,
        label: 'Google',
        match: [],
        username: 'kirin@example.com',
        seals: { password: SEAL.googlePassword },
        createdAt: T,
        updatedAt: T,
      },
      SITE: {
        key: KEY.SITE,
        label: 'Site',
        match: ['site.example'],
        method: { kind: 'google', via: 'GOOGLE' },
        seals: {},
        createdAt: T,
        updatedAt: T,
      },
      SUDO: {
        key: KEY.SUDO,
        label: 'sudo',
        match: ['sudo@kirin-box'],
        seals: { password: SEAL.sudoPassword },
        createdAt: T,
        updatedAt: T,
      },
    },
  };
}

/** A sealed document that counts its writes: the migration must make none. */
export class CountingSealed extends MemorySecretDocuments {
  writes = 0;
  failing = false;
  override async write(document: SecretVaultDocument): Promise<void> {
    if (this.failing) throw new Error('disk full writing the sealed logins');
    this.writes += 1;
    await super.write(document);
  }
}

/** An index whose next writes fail on demand: the commit, or the version 1 copy before it. */
export class FailingIndex extends MemoryLoginIndex {
  failCommit = false;
  failCopy = false;
  commits = 0;
  override async write(document: Parameters<MemoryLoginIndex['write']>[0]): Promise<void> {
    if (this.failCommit) throw new Error('disk full writing the index');
    this.commits += 1;
    await super.write(document);
  }
  override async keepVersion1(bytes: string): Promise<void> {
    if (this.failCopy) throw new Error('disk full writing the copy');
    await super.keepVersion1(bytes);
  }
}

/** The version 1 store on "disk": its index and its sealed document (with one orphan). */
export async function plant<Index extends MemoryLoginIndex = FailingIndex>(
  index: Index = new FailingIndex() as unknown as Index,
  sealed: CountingSealed = new CountingSealed(),
  options: { readonly orphan?: boolean } = {},
) {
  const cipher = new FakeSecretCipher();
  const entries: Record<string, { iv: string; ciphertext: string; createdAt: string; updatedAt: string }> = {};
  const values: Record<string, string> = {
    [SEAL.githubPassword]: GITHUB_PASSWORD,
    [SEAL.githubSeed]: SEED,
    [SEAL.googlePassword]: GOOGLE_PASSWORD,
    [SEAL.sudoPassword]: SUDO_PASSWORD,
    ...(options.orphan === false ? {} : { [SEAL.orphan]: 'orphan-UNIQUE-value-4' }),
  };
  for (const [name, value] of Object.entries(values))
    entries[name] = { ...(await cipher.seal(name, value)), createdAt: T, updatedAt: T };
  await sealed.write({ v: 1, cipher: cipher.algorithm, entries });
  sealed.writes = 0;
  index.document = version1();
  return { index, sealed, cipher };
}

/** One daemon over the files: building another over the same stores is a restart. */
export function daemonOver(
  index: MemoryLoginIndex,
  sealed: MemorySecretDocuments,
  options: AccountDirectoryOptions = {},
) {
  const cipher = new FakeSecretCipher();
  const vault = new AccountVault(index, sealed, cipher, { hostName: 'kirin-box.local', clock: CLOCK });
  const directory = new AccountDirectory(index, sealed, cipher, CLOCK, {
    hostName: 'kirin-box.local',
    seals: vault,
    ...options,
  });
  return { directory, vault };
}
