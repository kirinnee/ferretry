import type { StatePort } from '@ferretry/kernel/contract';
import { VaultFile, VaultKeyFile } from '../../../contract/index.ts';
import { SecretStoreError } from '../../lib/secrets/types.ts';

/** The two files the sealed store rests in: `state/vault/vault.json` and `state/vault/vault.key` (spine D16). */
type SealedFile = 'vault' | 'key';

/**
 * The sealed store's files as text, over the kernel's state port (today's `FileSystemPort.readText` /
 * `writeTextAtomic` + `setMode(0600)`). Both are declared `store: 'secret'`, so the kernel never parses them, never
 * reads one just to check it, writes atomically and keeps them `0600`; this adapter only turns bytes into text.
 *
 * A file the kernel could not read RAISES `unreadable`: damaged is never absent (§9.3), so it never answers
 * `undefined` for a file that is there.
 */
export interface SealedFiles {
  readText(file: SealedFile): Promise<string | undefined>;
  writeText(file: SealedFile, text: string): Promise<void>;
}

const DEFS = { vault: VaultFile, key: VaultKeyFile } as const;

export function kernelSealedFiles(state: StatePort): SealedFiles {
  return {
    async readText(file) {
      const read = await state.read(DEFS[file]);
      if (!read.ok) throw new SecretStoreError('unreadable', `${DEFS[file].path} could not be read`);
      const bytes = read.value as unknown;
      if (bytes === undefined) return undefined;
      if (!(bytes instanceof Uint8Array)) throw new SecretStoreError('unreadable', `${DEFS[file].path} is not a file`);
      return new TextDecoder().decode(bytes);
    },
    async writeText(file, text) {
      // A `secret` file holds bytes, not its declared shape: the kernel writes them as given, atomically, `0600`.
      await state.write(DEFS[file] as unknown as Parameters<StatePort['write']>[0], text as never);
    },
  };
}
