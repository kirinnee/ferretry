/**
 * The only thing in this daemon that opens a secret, and the only surface that changes one.
 *
 * TWO CLASSES ON PURPOSE, and the split is the security design rather than tidiness:
 *
 * - `SecretDirectory` is what a ROUTE is handed. It can list, replace and delete. It has no method
 *   that returns a value and no field it could reach one through, so "there is no API that returns a
 *   secret" is a fact about the type rather than a rule a reviewer has to check.
 * - `SecretVault` opens ciphertext. Exactly two things are given one — the redactor, which turns
 *   values into masks, and the use executor, which puts them in a child's environment and returns
 *   only that child's scrubbed output. Neither hands a value back to its caller.
 *
 * If a future change needs a vault somewhere else, that is the moment to re-derive the whole
 * property; adding a getter here quietly deletes it.
 */

import { MAX_SECRETS_PER_DAEMON, type SecretName, type SecretSummary } from '@ferretry/protocol';
import type { ClockPort } from '../ports.ts';
import {
  type SealedSecret,
  type SecretCipherPort,
  type SecretDocumentStore,
  SecretStoreError,
  type SecretVaultDocument,
} from './types.ts';

/** The document a store that has never been written stands in for. */
function emptyDocument(cipher: string): SecretVaultDocument {
  return { v: 1, cipher, entries: {} };
}

/**
 * A document whose cipher this daemon does not implement is DAMAGED, not empty.
 *
 * A daemon that silently ignored an unknown cipher would report an empty store over entries it
 * simply cannot read, and the person would recreate every secret on top of them.
 */
function requireCipherMatch(document: SecretVaultDocument, algorithm: string): SecretVaultDocument {
  if (document.cipher !== algorithm)
    throw new SecretStoreError(
      'unreadable',
      `the vault was sealed with ${document.cipher}, which this daemon does not open`,
    );
  return document;
}

/** Name and timestamps, sorted by name so a listing is stable between reads. */
function summaries(document: SecretVaultDocument): readonly SecretSummary[] {
  return Object.entries(document.entries)
    .map(([name, entry]) => ({ name, createdAt: entry.createdAt, updatedAt: entry.updatedAt }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The management surface: what exists, replacing one, removing one.
 *
 * There is deliberately no `get`. A value goes in and is never handed back — not to a route, not to
 * the CLI, not to a browser, not to a diagnostic. Replacing is the only edit, because a value is
 * opaque: there is nothing to show a person that they could sensibly amend.
 */
export class SecretDirectory {
  constructor(
    private readonly store: SecretDocumentStore,
    private readonly cipher: SecretCipherPort,
    private readonly clock: ClockPort,
  ) {}

  /** What this daemon holds. Raises `SecretStoreError` when it cannot tell — never an empty list. */
  async list(): Promise<readonly SecretSummary[]> {
    return summaries(await this.document());
  }

  /**
   * Stores a value under a name, replacing whatever was there.
   *
   * `createdAt` SURVIVES a replacement: "this credential has existed since March and was rotated on
   * Tuesday" is two different facts, and collapsing them loses the one an operator audits by.
   */
  async put(name: SecretName, value: string): Promise<SecretSummary> {
    const document = await this.document();
    const existing = document.entries[name];
    if (existing === undefined && Object.keys(document.entries).length >= MAX_SECRETS_PER_DAEMON)
      throw new SecretStoreError('full', `this daemon already holds ${MAX_SECRETS_PER_DAEMON} secrets`);
    const at = this.clock.now();
    const sealed: SealedSecret = {
      ...(await this.cipher.seal(name, value)),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    await this.store.write({ ...document, entries: { ...document.entries, [name]: sealed } });
    return { name, createdAt: sealed.createdAt, updatedAt: sealed.updatedAt };
  }

  /** Removes a secret. Answers whether there was one, so a caller can report an honest 404. */
  async remove(name: SecretName): Promise<boolean> {
    const document = await this.document();
    if (document.entries[name] === undefined) return false;
    const { [name]: _removed, ...rest } = document.entries;
    await this.store.write({ ...document, entries: rest });
    return true;
  }

  private async document(): Promise<SecretVaultDocument> {
    const stored = await this.store.read();
    if (stored === undefined) return emptyDocument(this.cipher.algorithm);
    return requireCipherMatch(stored, this.cipher.algorithm);
  }
}

/**
 * The plaintext side. Nothing that is handed one of these returns what it read.
 *
 * Deliberately NOT memoized. A cache would be hidden state whose invalidation is another thing to
 * get wrong, and opening a few hundred small AES-GCM entries costs less than the file read that
 * precedes it.
 */
export class SecretVault {
  constructor(
    private readonly store: SecretDocumentStore,
    private readonly cipher: SecretCipherPort,
  ) {}

  /**
   * Every secret this daemon holds, opened.
   *
   * A store that has never been written answers an EMPTY map, which is a fact. A store that is
   * damaged raises, because the caller — redaction, or a launch — must not proceed believing there
   * are no values to mask or to inject.
   */
  async values(): Promise<ReadonlyMap<SecretName, string>> {
    const stored = await this.store.read();
    if (stored === undefined) return new Map();
    const document = requireCipherMatch(stored, this.cipher.algorithm);
    const opened = new Map<SecretName, string>();
    for (const [name, entry] of Object.entries(document.entries)) opened.set(name, await this.cipher.open(name, entry));
    return opened;
  }
}
