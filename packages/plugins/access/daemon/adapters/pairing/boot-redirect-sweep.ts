import type { KernelPorts, StatePort } from '@ferretry/kernel/contract';
import {
  isPairingRedirectDirectoryName,
  isPairingRedirectStale,
  PAIRING_REDIRECT_FILE_NAME,
  PairingRedirectsFile,
} from '../../../contract/index.ts';

interface RedirectStat {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly modifiedMs: number;
}

/** TODO(kernel contract): lstat refuses symlink parents, never follows the leaf; directory removal is plain rmdir. */
export interface PairingRedirectStatePort extends StatePort {
  lstat(file: typeof PairingRedirectsFile, name: string): Promise<RedirectStat | undefined>;
  removeEmptyDirectory(file: typeof PairingRedirectsFile, name: string): Promise<void>;
}

/** TODO(kernel contract): DaemonHalf hook, awaited once under the home lock after state is ready, before listen. */
export interface PairingBootHalf {
  beforeListen(ctx: { readonly kernel: KernelPorts }): Promise<void>;
}

/** The actual daemon half exposes this hook even while the kernel dispatcher is pending. */
export function pairingRedirectBoot(): PairingBootHalf {
  return {
    beforeListen: async ({ kernel }) => {
      const state = kernel.state as Partial<PairingRedirectStatePort>;
      if (state.lstat === undefined || state.removeEmptyDirectory === undefined) {
        kernel.log.warn('pairing redirect boot cleanup needs kernel state lstat and empty-directory removal ports');
        return;
      }
      await sweepPairingRedirectState(state as PairingRedirectStatePort, kernel.clock.nowMs());
    },
  };
}

/** Today's sweep, inside Access's declared opaque tree: exact names, age, regular files, then plain rmdir. */
export async function sweepPairingRedirectState(state: PairingRedirectStatePort, nowMs: number): Promise<void> {
  let entries: readonly string[];
  try {
    entries = await state.list(PairingRedirectsFile);
  } catch {
    return;
  }
  for (const directory of entries) {
    if (!isPairingRedirectDirectoryName(directory)) continue;
    try {
      const parent = await state.lstat(PairingRedirectsFile, directory);
      if (parent?.kind !== 'directory') continue;
      const page = `${directory}/${PAIRING_REDIRECT_FILE_NAME}`;
      const details = await state.lstat(PairingRedirectsFile, page).catch(() => undefined);
      const written = details ?? parent;
      if (!isPairingRedirectStale(written.modifiedMs, nowMs)) continue;
      if (details?.kind === 'file') await state.remove(PairingRedirectsFile, page);
      await state.removeEmptyDirectory(PairingRedirectsFile, directory);
    } catch {
      // Absent, held open, unexpected contents or already gone: the sweep never prevents boot.
    }
  }
}
