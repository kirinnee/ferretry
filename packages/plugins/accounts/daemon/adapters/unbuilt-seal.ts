import type { SecretCipherPort, SecretDocumentStore } from '../lib/seal.ts';
import { SecretStoreError } from '../lib/seal.ts';

const SENTENCE = 'the Vault does not hold the accounts’ sealed values in this build yet; nothing was changed';

/**
 * The sealed store while the Vault's contract offers none (lead, 2026-11-07): every read and write fails CLOSED as
 * `key_missing`, so a change that seals or sweeps changes nothing, the listing still answers from the index, and no
 * value is ever kept anywhere but the Vault.
 */
export const UNBUILT_SEALED_STORE: SecretDocumentStore = {
  read: async () => {
    throw new SecretStoreError('key_missing', SENTENCE);
  },
  write: async () => {
    throw new SecretStoreError('key_missing', SENTENCE);
  },
};

export const UNBUILT_CIPHER: SecretCipherPort = {
  algorithm: 'AES-256-GCM',
  seal: async () => {
    throw new SecretStoreError('key_missing', SENTENCE);
  },
  openAll: async () => {
    throw new SecretStoreError('key_missing', SENTENCE);
  },
};
