/**
 * The GPG signing key of a Git account: made (or taken) here, registered at GitHub by its PUBLIC half so a commit shows
 * Verified, and used through a signature-only in-memory signer (`signer.ts`). It is the `signing` slot's other format: an
 * account signs with ONE key, SSH or GPG. The secret half is sealed under `<account id>:gpg` in the same private document
 * as the SSH keys (`keys.json`) and is unsealed only in daemon memory.
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
import type { GpgSigners, GpgKit } from './signer.ts';
import type { GpgMaterial } from './material.ts';

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
  readonly #revoking = new Set<GitAccountId>();
  constructor(
    private readonly accounts: KeyAccounts,
    private readonly sealed: SealedDocumentHandle,
    private readonly homes: GpgSigners,
    private readonly machineName: () => string,
    /** One operation at a time per account, shared with the SSH keys: both rewrite the same record. */
    private readonly exclusive: <T>(id: GitAccountId, work: () => Promise<T>) => Promise<T>,
  ) {}

  /** Makes (or takes) the account's key and registers its public half; asking again for the same key changes nothing. */
  create(id: GitAccountId, request: GitKeyRequest): Promise<GitGpgKeyResult> {
    return this.exclusive(id, async () => {
      const account = await this.#account(id);
      const held = account.keys.signing;
      if (held !== undefined) {
        if (held.revoking === true) throw refused('this signing key is being removed; retry its removal');
        const sealed = await this.#sealedKey(id);
        // The same ask again (no key handed over) answers what is already there.
        if (isGpgKey(held) && keptHere(held) && sealed !== undefined && request.keyBlock === undefined)
          return resultOf(sealed, held.source === 'imported' ? 'imported' : 'generated');
        throw refused('this account already has a signing key; remove it first');
      }
      this.#revoking.delete(id);
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
      const entry: GitAccountKey = {
        title: titleFor(this.machineName()),
        format: 'gpg',
        openpgpFingerprint: material.fingerprint,
        source,
      };
      let pending = false;
      let registered = false;
      let githubKeyId: string | undefined;
      try {
        if ((await this.#listed(account.id, material.fingerprint)) === undefined) {
          // Write intent BEFORE the upload. A death or final-record failure leaves a visible, non-signing,
          // retryable registration, even when the provider id never reached the account record.
          await this.accounts.recordKeys(id, {
            ...account.keys,
            signing: { ...entry, revoking: true, registrationPending: true },
          });
          pending = true;
          githubKeyId = await this.#register(account, material);
          registered = true;
        }
        await this.accounts.recordKeys(id, {
          ...account.keys,
          signing: { ...entry, ...(githubKeyId === undefined ? {} : { githubKeyId }) },
        });
      } catch (error) {
        await this.#drop(id);
        let cleaned =
          !pending || (registered && githubKeyId === undefined) || (error instanceof ApiError && error.status === 409);
        if (githubKeyId !== undefined) {
          try {
            const answer = await this.accounts.api(id, { method: 'DELETE', path: `${PATH}/${githubKeyId}` });
            cleaned = answer.status === 204 || answer.status === 404;
          } catch {
            cleaned = false;
          }
        }
        if (cleaned && pending) await this.accounts.recordKeys(id, account.keys);
        else if (githubKeyId !== undefined) {
          // A known POST id proves ownership. Preserve it when rollback fails; an unknown outcome is manual cleanup.
          await this.accounts
            .recordKeys(id, {
              ...account.keys,
              signing: { ...entry, githubKeyId, revoking: true, registrationPending: true },
            })
            .catch(() => undefined);
        }
        // Otherwise the durable intent stays. No unsealed/sealed capability is needed to retry its removal.
        throw error;
      }
      return resultOf(sealOf(material), source);
    });
  }

  /** Takes the signing key off the account at GitHub and out of the record, and forgets the secret half. */
  async removeLocked(id: GitAccountId): Promise<GitKeyRemoved> {
    const account = await this.#account(id);
    const key = account.keys.signing;
    if (!isGpgKey(key) || key === undefined)
      throw new ApiError(404, 'this account has no such key', GIT_ACCOUNT_CODES.unknownAccount);
    // Even a provider outage must not leave the account able to sign. Keep the public registration record on
    // failure so DELETE is retryable; launchKit refuses a record whose sealed capability has been removed.
    await this.forgetLocked(id);
    const githubKeyId = key.githubKeyId;
    if (
      githubKeyId === undefined &&
      key.registrationPending === true &&
      key.openpgpFingerprint !== undefined &&
      (await this.#listed(id, key.openpgpFingerprint)) !== undefined
    )
      throw refused(
        'the upload outcome is unknown; signing is stopped. Check this key at github.com/settings/keys before retrying or disconnecting',
        GIT_ACCOUNT_CODES.keyCleanupManual,
        502,
      );
    if (githubKeyId !== undefined) {
      const answer = await this.accounts.api(id, { method: 'DELETE', path: `${PATH}/${githubKeyId}` });
      if (answer.status !== 204 && answer.status !== 404)
        throw refused('GitHub did not delete the key; try again', GIT_ACCOUNT_CODES.providerRefused, 502);
    }
    const { signing: _gone, ...left } = account.keys;
    await this.accounts.recordKeys(id, left);
    return { id, purpose: 'signing', removed: true };
  }

  /**
   * What a ferret gets: a public-only home, fingerprint and signing shim.
   * `undefined` when the account signs some other way. A key that IS recorded but cannot be served throws, never answers
   * "no key": the launch would then fall back silently to whatever the machine signs with.
   */
  launchKit(id: GitAccountId): Promise<GpgKit | undefined> {
    return this.exclusive(id, async () => {
      const key = (await this.accounts.find(id))?.keys.signing;
      if (!isGpgKey(key) || !keptHere(key)) return undefined;
      if (key?.revoking === true || this.#revoking.has(id))
        throw refused('this GPG signing key is being removed; retry its removal');
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

  /** At boot: every active GPG key gets its signing socket back at its own path, so a ferret that outlived a restart finds it. */
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

  /** Caller already owns the account lock (disconnect snapshots keys and drops both capabilities under it). */
  async forgetLocked(id: GitAccountId): Promise<void> {
    this.#revoking.add(id);
    await this.homes.disable(id);
    let markerFailure: unknown;
    try {
      const account = await this.accounts.find(id);
      const key = account?.keys.signing;
      if (account !== undefined && isGpgKey(key) && key !== undefined && key.revoking !== true)
        await this.accounts.recordKeys(id, { ...account.keys, signing: { ...key, revoking: true } });
    } catch (error) {
      markerFailure = error;
    }
    // Failure to mark must not skip deletion from a healthy vault. Retain the original metadata for remote retry.
    try {
      await this.#drop(id);
    } catch (error) {
      throw markerFailure ?? error;
    }
    if (markerFailure !== undefined) throw markerFailure;
  }

  /** The daemon is stopping. */
  stop(): Promise<void> {
    return this.homes.stopAll();
  }

  async #drop(id: GitAccountId): Promise<void> {
    this.#revoking.add(id);
    const errors: unknown[] = [];
    for (const cleanup of [
      () => this.homes.disable(id),
      () => this.sealed.delete(sealedName(id)),
      () => this.homes.forget(id),
    ])
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length > 0) throw errors[0];
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
      if ((await this.#listed(account.id, material.fingerprint)) !== undefined) return undefined;
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
  async #listed(id: GitAccountId, fingerprint: string): Promise<{ id?: string } | undefined> {
    const keyId = fingerprint.slice(-16).toUpperCase();
    for (let page = 1; page <= 5; page += 1) {
      const answer = await this.accounts.api(id, { method: 'GET', path: `${PATH}?per_page=100&page=${String(page)}` });
      if (answer.status !== 200 || !Array.isArray(answer.body)) throw providerFailure(answer.status);
      const found = (answer.body as readonly { key_id?: unknown; id?: unknown }[]).find(
        entry => String(entry.key_id ?? '').toUpperCase() === keyId,
      );
      if (found !== undefined)
        return typeof found.id === 'number' && Number.isSafeInteger(found.id) && found.id > 0
          ? { id: String(found.id) }
          : {};
      if (answer.body.length < 100) break;
    }
    return undefined;
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
