/**
 * In-memory stores for the account store's tests (today's `runtime/mounts/support.ts` and
 * `secrets/accounts-fixtures.ts`, the parts half a uses). There is one index format, 1: nothing older is planted.
 */
import type { Instant } from '@ferretry/std';
import { type AccountIndexDocument, TotpParametersSchema } from '../../../contract/routes/index.ts';
import {
  AccountDirectory,
  type AccountDirectoryOptions,
  AccountVault,
  type LoginIndexStore,
} from '../../../daemon/lib/accounts.ts';
import {
  type SecretCipherPort,
  type SecretDocumentStore,
  SecretStoreError,
  type SecretVaultDocument,
} from '../../../daemon/lib/seal.ts';

export const CLOCK = { now: () => '2026-10-31T09:00:00.000Z' as Instant };
export const SEED = 'JBSWY3DPEHPK3PXP';

/** A reversible fake: reversing the text, filed under its own name so a value opened under another name fails. */
export class FakeSecretCipher implements SecretCipherPort {
  readonly algorithm = 'FAKE-REVERSED';

  async seal(name: string, plaintext: string): Promise<{ readonly iv: string; readonly ciphertext: string }> {
    return { iv: name, ciphertext: [...plaintext].reverse().join('') };
  }

  async openAll(
    entries: Readonly<Record<string, { readonly iv: string; readonly ciphertext: string }>>,
  ): Promise<ReadonlyMap<string, string>> {
    const opened = new Map<string, string>();
    for (const [name, sealed] of Object.entries(entries)) {
      if (sealed.iv !== name) throw new SecretStoreError('undecipherable', `${name} was filed under ${sealed.iv}`);
      opened.set(name, [...sealed.ciphertext].reverse().join(''));
    }
    return opened;
  }
}

/** A sealed document held in memory. `undefined` until something writes, exactly like a fresh home. */
export class MemorySecretDocuments implements SecretDocumentStore {
  private document: SecretVaultDocument | undefined;
  constructor(private readonly failure?: SecretStoreError) {}
  async read(): Promise<SecretVaultDocument | undefined> {
    if (this.failure !== undefined) throw this.failure;
    return this.document;
  }
  async write(document: SecretVaultDocument): Promise<void> {
    this.document = document;
  }
}

/** The index held in memory: `undefined` until written, or a failure for a damaged one. */
export class MemoryLoginIndex implements LoginIndexStore {
  document: AccountIndexDocument | undefined;
  constructor(private readonly failure?: SecretStoreError) {}
  async read(): Promise<AccountIndexDocument | undefined> {
    if (this.failure !== undefined) throw this.failure;
    return this.document;
  }
  async write(document: AccountIndexDocument): Promise<void> {
    this.document = document;
  }
  /** The committed index; a test that reads one before anything committed fails here. */
  get accounts(): AccountIndexDocument {
    if (this.document === undefined) throw new Error('no index has been committed');
    return this.document;
  }
}

/** A sealed document that counts its writes, and fails them on demand. */
export class CountingSealed extends MemorySecretDocuments {
  writes = 0;
  failing = false;
  override async write(document: SecretVaultDocument): Promise<void> {
    if (this.failing) throw new Error('disk full writing the sealed logins');
    this.writes += 1;
    await super.write(document);
  }
}

/** One daemon over the stores: building another over the same stores is a restart. */
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

/** Saves a 2FA seed on an account the way the commit does, without a stage. */
export async function plantSeed(
  accounts: Pick<AccountDirectory, 'seedTarget' | 'addSeed'>,
  id: string,
  seed: string,
  label?: string,
  params: Parameters<typeof TotpParametersSchema.parse>[0] = {},
): Promise<void> {
  const { key } = await accounts.seedTarget(id);
  await accounts.addSeed(key, seed, {
    params: TotpParametersSchema.parse(params),
    ...(label === undefined ? {} : { label }),
  });
}

/**
 * The Vault's sealed documents in memory, recording every call in order and failing a put on demand: what the
 * reseal-order tests (S83) need beyond the Vault's own `FakeSealedDocuments`.
 */
export class NamedSealedDocuments {
  readonly values = new Map<string, string>();
  readonly calls: string[] = [];
  failPut = false;
  open(_own: unknown, _document: unknown) {
    return {
      put: async (name: string, value: string | Uint8Array) => {
        this.calls.push(`put ${name}`);
        if (this.failPut) throw new Error('disk full');
        this.values.set(name, typeof value === 'string' ? value : new TextDecoder().decode(value));
      },
      get: async (name: string) => {
        this.calls.push(`get ${name}`);
        return this.values.get(name);
      },
      getBytes: async (name: string) => {
        const value = this.values.get(name);
        return value === undefined ? undefined : new TextEncoder().encode(value);
      },
      delete: async (name: string) => {
        this.calls.push(`delete ${name}`);
        return this.values.delete(name);
      },
      names: async () => [...this.values.keys()],
    };
  }
}
