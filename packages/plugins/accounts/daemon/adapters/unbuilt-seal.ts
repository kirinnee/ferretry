import type { SecretCipherPort, SecretDocumentStore } from '../lib/seal.ts';
import { SecretStoreError } from '../lib/seal.ts';

const SENTENCE = 'the Vault does not hold the accounts’ sealed values in this build yet; nothing was changed';

/**
 * The sealed store while the Vault's contract offers none (lead, 2026-11-07). Nothing can ever have been sealed in
 * this build, so it reads as EMPTY, and every account change that seals nothing (an account, a sign-in, a 2FA key with
 * no value) still works. Every write that would seal a value fails CLOSED as `key_missing`, before the index is
 * written, so no value is ever kept anywhere but the Vault.
 */
export const UNBUILT_SEALED_STORE: SecretDocumentStore = {
  read: async () => undefined,
  write: async () => {
    throw new SecretStoreError('key_missing', SENTENCE);
  },
};

export const UNBUILT_CIPHER: SecretCipherPort = {
  algorithm: 'AES-256-GCM',
  seal: async () => {
    throw new SecretStoreError('key_missing', SENTENCE);
  },
  openAll: async entries => {
    if (Object.keys(entries).length === 0) return new Map();
    throw new SecretStoreError('key_missing', SENTENCE);
  },
};
