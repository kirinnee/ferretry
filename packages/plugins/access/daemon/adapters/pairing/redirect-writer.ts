import type { StatePort } from '@ferretry/kernel/contract';
import {
  PAIRING_REDIRECT_DIRECTORY_PREFIX,
  PAIRING_REDIRECT_FILE_NAME,
  PairingRedirectsFile,
} from '../../../contract/index.ts';
import type { PairingRedirectWriter } from '../../lib/routes/pairing-redirect.ts';

/** What the writer needs of Access's own (pinned) state: the kernel's scoped StatePort members, nothing wider. */
export type PairingRedirectWriteState = Pick<
  StatePort,
  'createPrivateDirectory' | 'write' | 'remove' | 'removeEmptyDirectory'
>;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** `mkdtemp`'s shape: six characters of the alphanumerics, the one spelling the sweep matches exactly. */
const suffix = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => ALPHABET[byte % ALPHABET.length]).join('');

/**
 * Makes the redirect page through the daemon's own state port, so the page is pinned by identity before the write
 * returns (the fence index looks again) and the directory that held it is gone again if any step fails.
 */
export function stateRedirectWriter(state: PairingRedirectWriteState): PairingRedirectWriter {
  return {
    write: async page => {
      const directory = `${PAIRING_REDIRECT_DIRECTORY_PREFIX}${suffix()}`;
      const name = `${directory}/${PAIRING_REDIRECT_FILE_NAME}`;
      await state.createPrivateDirectory(PairingRedirectsFile, directory);
      try {
        await state.write(PairingRedirectsFile, new TextEncoder().encode(page), name);
        return directory;
      } catch (error) {
        await state.remove(PairingRedirectsFile, name).catch(() => undefined);
        await state.removeEmptyDirectory(PairingRedirectsFile, directory).catch(() => undefined);
        throw error;
      }
    },
  };
}
