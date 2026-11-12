import { err, ok, type Result } from '@ferretry/std';
import type { BoundDirectory, BoundDirectoryRefusal } from '../contract/ports.ts';
import type { HostFs } from './adapters/node-fs.ts';
import { fencedReal, fenceOf, hopsThroughFence } from './fence-guard.ts';
import type { TruncationWatcher } from './fence-index.ts';
import { checkDirectory } from './paths.ts';

/** The home's private places, as the roots hold them: what the fence indexes by identity. */
export interface BoundPrivatePlaces {
  readonly files: readonly string[];
  readonly recheckMs: number;
  readonly watch?: TruncationWatcher;
}

/** What the folder is, as one look sees it: where it really is, which directory that is, and the fence's answer. */
interface Look {
  readonly realPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly insideStateHome: boolean;
}

/**
 * `PathsPort.bindDirectory`: {@link checkDirectory}'s answer remembered with the identity of the directory it resolved to
 * (device and inode) and the state-home fence's answer — by name, by identity up every folder, and through a link that
 * lives in the home (the same three judgements the owner roots make). `verify` runs the SAME look again and compares.
 * Every doubt fails closed: a fence that cannot be computed refuses the bind (`unresolved`); a look that fails at
 * verify holds the launch (`unresolved`); a difference holds it (`changed`). Nothing is created and nothing throws.
 *
 * What it does not do: hold the directory open for the child. The runner still starts the process by path, so a swap in
 * the instant between `verify` and the child's `chdir` is not seen (a declared GAP).
 */
export async function bindDirectory(
  fs: HostFs,
  home: string,
  places: BoundPrivatePlaces,
  absolutePath: string,
): Promise<Result<BoundDirectory, BoundDirectoryRefusal>> {
  const requested = absolutePath.trim();
  const look = async (): Promise<Result<Look, BoundDirectoryRefusal>> => {
    const checked = await checkDirectory(fs, requested);
    if (!checked.ok) return err({ reason: checked.error.reason, message: checked.error.message });
    const realPath = checked.value.realPath;
    const found = await fs.identity(realPath);
    if (found?.kind !== 'directory')
      return err({ reason: 'not_a_directory', message: `session working directory is not a directory: ${requested}` });
    const fence = await fenceOf(fs, home, places.files, places.recheckMs, places.watch);
    const insideStateHome = (await hopsThroughFence(fs, fence, requested)) || (await fencedReal(fs, fence, realPath));
    return ok({ realPath, device: found.device, inode: found.inode, insideStateHome });
  };
  const unresolved = (): BoundDirectoryRefusal => ({
    reason: 'unresolved',
    message: `the launch folder ${requested} could not be checked against this daemon's state home, so nothing was started in it`,
  });
  let first: Result<Look, BoundDirectoryRefusal>;
  try {
    first = await look();
  } catch {
    return err(unresolved());
  }
  if (!first.ok) return first;
  const captured = first.value;
  return ok({
    realPath: captured.realPath,
    insideStateHome: captured.insideStateHome,
    verify: async () => {
      let again: Result<Look, BoundDirectoryRefusal>;
      try {
        again = await look();
      } catch {
        return err(unresolved());
      }
      const changed = (): BoundDirectoryRefusal => ({
        reason: 'changed',
        message: `the launch folder ${requested} is no longer what was checked, so nothing was started in it`,
      });
      if (!again.ok) return err(again.error.reason === 'unresolved' ? again.error : changed());
      const now = again.value;
      if (
        now.realPath !== captured.realPath ||
        now.device !== captured.device ||
        now.inode !== captured.inode ||
        now.insideStateHome !== captured.insideStateHome
      )
        return err(changed());
      return ok(undefined);
    },
  });
}
