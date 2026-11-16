import type { StatePort } from '@ferretry/kernel/contract';
import {
  PAIRING_REDIRECT_DIRECTORY_PREFIX,
  PAIRING_REDIRECT_FILE_NAME,
  PAIRING_REDIRECT_STALE_AFTER_MS,
  PairingRedirectsFile,
} from '../../../contract/index.ts';
import type { PairingRedirectWriter } from '../../lib/routes/pairing-redirect.ts';
import { type PairingRedirectStatePort, sweepPairingRedirectState } from './boot-redirect-sweep.ts';

/** What the writer needs of Access's own (pinned) state: the kernel's scoped StatePort members, nothing wider. */
export type PairingRedirectWriteState = Pick<
  StatePort,
  'createPrivateDirectory' | 'write' | 'remove' | 'removeEmptyDirectory'
> &
  PairingRedirectStatePort;

/** What the writer needs of the kernel's clock: the time, and one call after a delay. */
export interface PairingRedirectClock {
  nowMs(): number;
  after(delay: number, fn: () => void): unknown;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** `mkdtemp`'s shape: six characters of the alphanumerics, the one spelling the sweep matches exactly. */
const suffix = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => ALPHABET[byte % ALPHABET.length]).join('');

/**
 * Makes the redirect page through the daemon's own state port, so the page is pinned by identity before the write
 * returns (the fence index looks again) and the directory that held it is gone again if any step fails.
 *
 * THE DAEMON ENDS THE PAGE'S LIFE TOO. The CLI removes the page when it is done, but a lost 201, a CLI killed before it
 * knew the directory, or an `FY_HOME` that does not match leaves a page holding a live code that nobody else would look
 * for until the next `fy pair` or boot. So each page arms one timer on the daemon's own clock, for just past the stale
 * age, that runs the same sweep the boot runs: any page older than {@link PAIRING_REDIRECT_STALE_AFTER_MS} goes, whoever
 * made it, and a page already taken away is simply not found. `after` is the kernel clock's call; `delay` is in
 * milliseconds here, the caller adapts the kernel's duration type.
 */
export function stateRedirectWriter(
  state: PairingRedirectWriteState,
  clock: PairingRedirectClock,
): PairingRedirectWriter {
  return {
    write: async page => {
      const directory = `${PAIRING_REDIRECT_DIRECTORY_PREFIX}${suffix()}`;
      const name = `${directory}/${PAIRING_REDIRECT_FILE_NAME}`;
      await state.createPrivateDirectory(PairingRedirectsFile, directory);
      try {
        await state.write(PairingRedirectsFile, new TextEncoder().encode(page), name);
      } catch (error) {
        await state.remove(PairingRedirectsFile, name).catch(() => undefined);
        await state.removeEmptyDirectory(PairingRedirectsFile, directory).catch(() => undefined);
        throw error;
      }
      // One millisecond past the stale age, because "older than" is strictly greater. The sweep never rejects.
      clock.after(PAIRING_REDIRECT_STALE_AFTER_MS + 1, () => void sweepPairingRedirectState(state, clock.nowMs()));
      return directory;
    },
  };
}
