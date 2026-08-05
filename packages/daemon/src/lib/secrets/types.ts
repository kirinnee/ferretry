/**
 * The durable shape of this daemon's secret store, and every boundary it depends on.
 *
 * READ `docs/secrets.md` FOR THE THREAT MODEL. In one paragraph: the values rest encrypted under a
 * key held in a separate file, both `0600`, so the single most likely accidental disclosure — one
 * file copied into a backup, a tarball, a bug report or a chat — fails safe. It is NOT protection
 * against anyone who can read both files, which is anyone with the user account this daemon runs as.
 * Saying otherwise would be the overclaim this whole subsystem exists to avoid.
 *
 * THERE IS NO PORT HERE THAT HANDS A VALUE TO A CALLER. `SecretDirectory` — the management surface a
 * route is given — cannot reach one; only `SecretVault` opens ciphertext, and the only things given a
 * vault are the redactor and the use executor, neither of which returns what it read. That is a
 * structural guarantee rather than a rule someone has to remember.
 */

import type { SecretName } from '@ferretry/protocol';

/** How the store failed. Each is a DIFFERENT operator action, so none of them collapses into one. */
export type SecretStoreFailure =
  /** The document exists and cannot be parsed as this daemon's vault. */
  | 'unreadable'
  /** Ciphertext exists and the key that opens it does not. */
  | 'key_missing'
  /** The key exists and does not open the ciphertext: a wrong key, or a tampered document. */
  | 'undecipherable'
  /** The store already holds as many secrets as it will. */
  | 'full';

/**
 * A store that cannot answer.
 *
 * IT IS NEVER PROJECTED AS AN EMPTY STORE. A person told "no secrets" over a vault that is merely
 * unreadable will recreate every one of them on top of a file that is still there, and this project
 * has already shipped three variants of "damaged state read as empty state". The failure travels.
 */
export class SecretStoreError extends Error {
  constructor(
    readonly failure: SecretStoreFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

/** A named secret that does not exist here. Raised on USE, never on read — nothing reads a value. */
export class UnknownSecretError extends Error {
  constructor(readonly names: readonly SecretName[]) {
    super(`this daemon holds no secret named ${names.join(', ')}`);
    this.name = 'UnknownSecretError';
  }
}

/** One secret as it rests: opaque bytes plus the two facts a person is allowed to see about it. */
export interface SealedSecret {
  /** Base64 AES-GCM initialization vector. Unique per write; a reused one would leak plaintext. */
  readonly iv: string;
  /** Base64 ciphertext with its authentication tag appended, as WebCrypto produces it. */
  readonly ciphertext: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The whole vault document, exactly as it rests on disk. */
export interface SecretVaultDocument {
  readonly v: 1;
  /** The algorithm the entries were sealed with, so a future change can refuse rather than guess. */
  readonly cipher: string;
  readonly entries: Readonly<Record<string, SealedSecret>>;
}

/**
 * Durable boundary for the vault document.
 *
 * `read` answers `undefined` ONLY for a store that has never been written. Anything else — a file
 * that will not parse, a key that is gone — raises `SecretStoreError`, because those are not the
 * same fact and a caller that cannot tell them apart will invent data.
 */
export interface SecretDocumentStore {
  read(): Promise<SecretVaultDocument | undefined>;
  write(document: SecretVaultDocument): Promise<void>;
}

/**
 * Sealing and opening one value. A capability, so it is injected rather than reached for.
 *
 * `name` IS AUTHENTICATED DATA, not decoration: binding the ciphertext to the name it is filed under
 * means an entry cannot be moved from `STAGING_KEY` to `PRODUCTION_KEY` by editing the document.
 */
export interface SecretCipherPort {
  /** Names the algorithm for the document, so what sealed an entry is recorded beside it. */
  readonly algorithm: string;
  seal(name: SecretName, plaintext: string): Promise<{ readonly iv: string; readonly ciphertext: string }>;
  /** Raises `SecretStoreError('undecipherable')` when the key does not open it. */
  open(name: SecretName, sealed: { readonly iv: string; readonly ciphertext: string }): Promise<string>;
}

/**
 * Where this daemon's configuration names secrets, so an unresolvable reference can be SEEN rather
 * than discovered by a child that fails for a reason nobody can read.
 */
export interface SecretReferenceSource {
  /** Every `${secret:NAME}` in the operator's configuration, with a human-readable origin. */
  references(): Promise<readonly { readonly name: SecretName; readonly origin: string }[]>;
}

/** What a use child is asked to do, once every reference has been resolved. */
export interface SecretChildSpec {
  readonly command: readonly string[];
  readonly cwd: string;
  /** The child's environment, INCLUDING the resolved secret values. It exists only here. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/** What running one produced. Raw — redaction happens in the domain, above this boundary. */
export interface SecretChildOutcome {
  readonly outcome: 'exited' | 'timeout' | 'spawn_failed';
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/**
 * Spawning one child with a secret in its environment.
 *
 * THE ADAPTER MUST NEVER PUT THE COMMAND OR ITS ENVIRONMENT IN A LOG, an error message or a thrown
 * stack. A spawn failure is reported by its outcome and by nothing that quotes what was spawned:
 * argv is chosen by the caller and a caller that wrote a value into argv would otherwise have it
 * echoed straight back out through the diagnostic path.
 */
export interface SecretChildRunner {
  run(spec: SecretChildSpec): Promise<SecretChildOutcome>;
}
