import type { KernelPorts, StatePort } from '@ferretry/kernel/contract';
import {
  isPairingRedirectDirectoryName,
  isPairingRedirectStale,
  PAIRING_REDIRECT_FILE_NAME,
  PairingRedirectsFile,
} from '../../../contract/index.ts';

/** What the sweep needs of Access's own state: the kernel's scoped StatePort members, nothing wider. */
export type PairingRedirectStatePort = Pick<StatePort, 'list' | 'stat' | 'remove' | 'removeEmptyDirectory'>;

/** The daemon half's `beforeListen`: the kernel awaits it once under the home lock, after state is ready. */
export function pairingRedirectBoot(): {
  readonly beforeListen: (ctx: { readonly kernel: KernelPorts }) => Promise<void>;
} {
  return {
    beforeListen: async ({ kernel }) => {
      await sweepPairingRedirectState(kernel.state, kernel.clock.nowMs());
    },
  };
}

/** Today's sweep, inside Access's declared opaque tree: exact names, age, regular files, then plain rmdir. */
async function sweepPairingRedirectState(state: PairingRedirectStatePort, nowMs: number): Promise<void> {
  let entries: readonly string[];
  try {
    entries = await state.list(PairingRedirectsFile);
  } catch {
    return;
  }
  for (const directory of entries) {
    if (!isPairingRedirectDirectoryName(directory)) continue;
    try {
      const parent = await state.stat(PairingRedirectsFile, directory);
      if (parent?.kind !== 'directory') continue;
      const page = `${directory}/${PAIRING_REDIRECT_FILE_NAME}`;
      const details = await state.stat(PairingRedirectsFile, page).catch(() => undefined);
      const written = details ?? parent;
      if (!isPairingRedirectStale(written.modifiedMs, nowMs)) continue;
      if (details?.kind === 'file') await state.remove(PairingRedirectsFile, page);
      await state.removeEmptyDirectory(PairingRedirectsFile, directory);
    } catch {
      // Absent, held open, unexpected contents or already gone: the sweep never prevents boot.
    }
  }
}
