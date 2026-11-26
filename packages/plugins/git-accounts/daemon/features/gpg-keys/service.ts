/**
 * The GPG signing key of a Git account: made (or taken) here, registered at GitHub by its PUBLIC half so a commit shows
 * Verified, and used by a ferret through an isolated `GNUPGHOME` (`gnupg.ts`). It is the `signing` slot's other format: an
 * account signs with ONE key, SSH or GPG. The secret half is sealed under `<account id>:gpg` in the same private document
 * as the SSH keys (`keys.json`) and leaves it only on `gpg --import`'s stdin.
 */
import { ApiError } from '@ferretry/kernel/contract';
import type { SealedDocumentHandle, SealedName } from '@ferretry/core-vault/contract';
import {
  GIT_ACCOUNT_CODES,
  type GitAccount,
  type GitAccountId,
  type GitAccountKey,
  type GitGpgKeyResult,
  type GitKeyRemoved,
  type GitKeyRequest,
  isGpgKey,
  keptHere,
} from '../../../contract/index.ts';
import { noreplyEmail } from '../launch/environment.ts';
import type { KeyAccounts } from '../ssh-keys/service.ts';
import type { GnupgHomes, GpgKit, GpgMaterial } from './gnupg.ts';

const PATH = '/user/gpg_keys';

interface SealedGpg {
  readonly secretKey: string;
  readonly publicKey: string;
  readonly fingerprint: string;
}

const sealedName = (id: GitAccountId): SealedName => `${id}:gpg` as SealedName;
const refused = (message: string, code: string = GIT_ACCOUNT_CODES.keyRefused, status = 409): ApiError =>
  new ApiError(status, message, code);
const providerFailure = (status: number): ApiError =>
  new ApiError(502, `GitHub answered ${String(status)}`, GIT_ACCOUNT_CODES.providerRefused);

/** A GitHub key title: plain printable characters, the machine's name after `Ferretry`. */
function titleFor(machine: string): string {
  const plain = machine.replace(/[^\x20-\x7e]/gu, '?').trim();
  return `Ferretry ${plain === '' ? 'machine' : plain}`.slice(0, 200);
}

export class GpgKeyService {
  constructor(
    private readonly accounts: KeyAccounts,
    private readonly sealed: SealedDocumentHandle,
    private readonly homes: GnupgHomes,
    private readonly machineName: () => string,
    /** One operation at a time per account, shared with the SSH keys: both rewrite the same record. */
    private readonly exclusive: <T>(id: GitAccountId, work: () => Promise<T>) => Promise<T>,
  ) {}

  /** Whether this account's signing key is a GPG one (so a `DELETE …/keys/signing` is ours). */
  async holdsSigning(id: GitAccountId): Promise<boolean> {
    return isGpgKey((await this.accounts.find(id))?.keys.signing);
  }

  /** Makes (or takes) the account's key and registers its public half; asking again for the same key changes nothing. */
  create(id: GitAccountId, request: GitKeyRequest): Promise<GitGpgKeyResult> {
    return this.exclusive(id, async () => {
      const account = await this.#account(id);
      const held = account.keys.signing;
      if (held !== undefined) {
        const sealed = await this.#sealedKey(id);
        // The same ask again (no key handed over) answers what is already there.
        if (isGpgKey(held) && keptHere(held) && sealed !== undefined && request.keyBlock === undefined)
          return resultOf(sealed, held.source === 'imported' ? 'imported' : 'generated');
        throw refused('this account already has a signing key; remove it first');
      }
      const identity = { name: account.name ?? account.login, email: noreplyEmail(account) };
      // A key that cannot be made or taken leaves no home behind.
      const material = await (request.keyBlock === undefined
        ? this.homes.generate(id, identity)
        : this.homes.receive(id, request.keyBlock, identity)
      ).catch(async (error: unknown) => {
        await this.homes.forget(id);
        throw error;
      });
      const source = request.keyBlock === undefined ? 'generated' : 'imported';
      await this.sealed.put(sealedName(id), JSON.stringify(sealOf(material)));
      try {
        const githubKeyId = await this.#register(account, material);
        const title = titleFor(this.machineName());
        const entry: GitAccountKey = {
          ...(githubKeyId === undefined ? {} : { githubKeyId }),
          title,
          format: 'gpg',
          openpgpFingerprint: material.fingerprint,
          source,
        };
        await this.accounts.recordKeys(id, { ...account.keys, signing: entry });
      } catch (error) {
        // A key GitHub never took (and the record never named) must not stay sealed, nor in a home.
        await this.sealed.delete(sealedName(id)).catch(() => undefined);
        await this.homes.forget(id);
        throw error;
      }
      return resultOf(sealOf(material), source);
    });
  }

  /** Takes the signing key off the account at GitHub and out of the record, and forgets the secret half. */
  remove(id: GitAccountId): Promise<GitKeyRemoved> {
    return this.exclusive(id, async () => {
      const account = await this.#account(id);
      const key = account.keys.signing;
      if (!isGpgKey(key) || key === undefined)
        throw new ApiError(404, 'this account has no such key', GIT_ACCOUNT_CODES.unknownAccount);
      if (key.githubKeyId !== undefined) {
        const answer = await this.accounts.api(id, { method: 'DELETE', path: `${PATH}/${key.githubKeyId}` });
        if (answer.status !== 204 && answer.status !== 404)
          throw refused('GitHub did not delete the key; try again', GIT_ACCOUNT_CODES.providerRefused, 502);
      }
      const { signing: _gone, ...left } = account.keys;
      await this.accounts.recordKeys(id, left);
      await this.#drop(id);
      return { id, purpose: 'signing', removed: true };
    });
  }

  /**
   * What a ferret's launch is given for this account's signing key: its home, the fingerprint and the real `gpg`.
   * `undefined` when the account signs some other way. A key that IS recorded but cannot be served throws, never answers
   * "no key": the launch would then fall back silently to whatever the machine signs with.
   */
  launchKit(id: GitAccountId): Promise<GpgKit | undefined> {
    return this.exclusive(id, async () => {
      const key = (await this.accounts.find(id))?.keys.signing;
      if (!isGpgKey(key) || !keptHere(key)) return undefined;
      const sealed = await this.#sealedKey(id);
      if (sealed === undefined)
        throw new ApiError(
          503,
          'the GPG key for this Git account could not be set up',
          GIT_ACCOUNT_CODES.agentUnavailable,
        );
      return await this.homes.kit(id, sealed.secretKey);
    });
  }

  /** At boot: every account with a GPG key gets its home back at its own path, so a ferret that outlived a restart finds it. */
  async warm(ids: readonly GitAccountId[], log: (id: GitAccountId) => void): Promise<void> {
    for (const id of ids)
      await this.launchKit(id).catch(() => {
        log(id);
        return undefined;
      });
  }

  /** The account is going: forget the secret half and end its agent. */
  forget(id: GitAccountId): Promise<void> {
    return this.exclusive(id, () => this.#drop(id));
  }

  /** The daemon is stopping. */
  stop(): Promise<void> {
    return this.homes.stopAll();
  }

  async #drop(id: GitAccountId): Promise<void> {
    await this.homes.forget(id);
    await this.sealed.delete(sealedName(id));
  }

  /**
   * The key at GitHub: its id when we put it there. A key the account already holds (422) is recorded without an id, so
   * removing it here never deletes what was not ours to delete; a 422 for any other reason is the person's to fix.
   */
  async #register(account: GitAccount, material: GpgMaterial): Promise<string | undefined> {
    const answer = await this.accounts.api(account.id, {
      method: 'POST',
      path: PATH,
      body: { name: titleFor(this.machineName()), armored_public_key: material.publicKey },
    });
    if (answer.status === 422) {
      if (await this.#listed(account.id, material.fingerprint)) return undefined;
      throw refused('GitHub refused the key (it may already be used by another account)');
    }
    const id = (answer.body as { id?: unknown } | null | undefined)?.id;
    if (
      (answer.status !== 201 && answer.status !== 200) ||
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id < 1
    )
      throw providerFailure(answer.status);
    return String(id);
  }

  /** Whether the account lists this key (GitHub names a key by the last sixteen hex digits of its fingerprint). */
  async #listed(id: GitAccountId, fingerprint: string): Promise<boolean> {
    const keyId = fingerprint.slice(-16).toUpperCase();
    for (let page = 1; page <= 5; page += 1) {
      const answer = await this.accounts.api(id, { method: 'GET', path: `${PATH}?per_page=100&page=${String(page)}` });
      if (answer.status !== 200 || !Array.isArray(answer.body)) throw providerFailure(answer.status);
      if (
        (answer.body as readonly unknown[]).some(
          entry => String((entry as { key_id?: unknown }).key_id ?? '').toUpperCase() === keyId,
        )
      )
        return true;
      if (answer.body.length < 100) break;
    }
    return false;
  }

  async #sealedKey(id: GitAccountId): Promise<SealedGpg | undefined> {
    const text = await this.sealed.get(sealedName(id));
    if (text === undefined) return undefined;
    try {
      const value = JSON.parse(text) as Partial<SealedGpg>;
      if (
        typeof value.secretKey === 'string' &&
        typeof value.publicKey === 'string' &&
        typeof value.fingerprint === 'string'
      )
        return { secretKey: value.secretKey, publicKey: value.publicKey, fingerprint: value.fingerprint };
    } catch {
      // a damaged entry is no key: the launch says so
    }
    return undefined;
  }

  async #account(id: GitAccountId): Promise<GitAccount> {
    const account = await this.accounts.find(id);
    if (account === undefined) throw new ApiError(404, 'no such Git account', GIT_ACCOUNT_CODES.unknownAccount);
    return account;
  }
}

const sealOf = (material: GpgMaterial): SealedGpg => ({
  secretKey: material.secretKey,
  publicKey: material.publicKey,
  fingerprint: material.fingerprint,
});

const resultOf = (key: SealedGpg, source: 'generated' | 'imported'): GitGpgKeyResult => ({
  format: 'gpg',
  publicKey: key.publicKey,
  fingerprint: key.fingerprint,
  registered: ['signing'],
  source,
});
