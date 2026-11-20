import { type AccountIndexDocument, TotpParametersSchema } from '@ferretry/protocol';
import {
  AccountDirectory,
  type AccountDirectoryOptions,
  AccountVault,
  type SecretVaultDocument,
} from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments } from '../runtime/mounts/support.ts';

/** An account store, and a daemon booting over it. */

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
 * GitHub (a website and an ssh host, a password and a 2FA key, a recipe with auto-apply, a proposal, a fact seen on its
 * site), Google (an account that signs in on no site), a site that went via it, and sudo on this machine.
 */
function storedAccounts(): AccountIndexDocument {
  return {
    v: 2,
    accounts: {
      GITHUB: {
        key: KEY.GITHUB,
        label: 'GitHub',
        username: 'kirin',
        seals: { password: SEAL.githubPassword },
        factors: [
          {
            id: 'tf_000000000001',
            kind: 'totp',
            label: 'Authenticator app',
            seal: SEAL.githubSeed,
            params: TotpParametersSchema.parse({}),
            addedAt: T,
            addedBy: 'owner',
          },
        ],
        createdAt: T,
        updatedAt: T,
      },
      GOOGLE: {
        key: KEY.GOOGLE,
        label: 'Google',
        username: 'kirin@example.com',
        seals: { password: SEAL.googlePassword },
        createdAt: T,
        updatedAt: T,
      },
      SITE: { key: KEY.SITE, label: 'Site', seals: {}, createdAt: T, updatedAt: T },
      SUDO: { key: KEY.SUDO, label: 'sudo', seals: { password: SEAL.sudoPassword }, createdAt: T, updatedAt: T },
    },
    signIns: {
      si_0000000000000001: {
        account: KEY.GITHUB,
        place: { kind: 'site', domains: ['github.com'], match: ['github.com'] },
        recipe: 'Open github.com and sign in',
        recipeVersion: 1,
        autoApplyRecipe: true,
        observed: [fact('github.com')],
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
      si_0000000000000002: {
        account: KEY.GITHUB,
        place: { kind: 'terminal', tool: 'ssh', host: 'kirin-box', dest: 'build.example.com' },
        createdAt: T,
        updatedAt: T,
      },
      si_0000000000000003: {
        account: KEY.SITE,
        place: { kind: 'site', domains: ['site.example'], match: ['site.example'] },
        method: { kind: 'google' },
        createdAt: T,
        updatedAt: T,
      },
      si_0000000000000004: {
        account: KEY.SUDO,
        place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
        createdAt: T,
        updatedAt: T,
      },
    },
  };
}

/** A sealed document that counts its writes: a boot that sweeps nothing must make none. */
export class CountingSealed extends MemorySecretDocuments {
  writes = 0;
  failing = false;
  override async write(document: SecretVaultDocument): Promise<void> {
    if (this.failing) throw new Error('disk full writing the sealed logins');
    this.writes += 1;
    await super.write(document);
  }
}

/** The store on "disk": its index and its sealed document (with one orphan unless `orphan` is false). */
export async function plant(
  index: MemoryLoginIndex = new MemoryLoginIndex(),
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
  index.document = storedAccounts();
  return { index, sealed, cipher };
}

/** One daemon over the files: building another over the same stores is a restart. */
export function daemonOver(
  index: MemoryLoginIndex,
  sealed: MemorySecretDocuments,
  options: AccountDirectoryOptions = {},
) {
  const cipher = new FakeSecretCipher();
  const vault = new AccountVault(index, sealed, cipher);
  const directory = new AccountDirectory(index, sealed, cipher, CLOCK, {
    hostName: 'kirin-box.local',
    seals: vault,
    ...options,
  });
  return { directory, vault };
}
