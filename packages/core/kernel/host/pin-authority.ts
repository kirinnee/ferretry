import type { HeldRoot, PinOptions } from '../contract/pinned.ts';
import type { HostFs } from './adapters/node-fs.ts';
import type { Manifest } from '../manifest/types.ts';
import type { RootName } from '../contract/ports.ts';
import type { Admission } from '../contract/bound.ts';
import type { CallScope } from './call-scope.ts';
import { currentActor, currentStanding } from './call-scope.ts';
import { PermissionError } from './permissions.ts';
import type { PinRegistry, UnjudgedRoot } from './pins.ts';

/** The declaration permits the ASK; only Gate's current caller judgment can authorize it. Unknown always refuses. */
export function mayWritePin(
  manifest: Manifest,
  root: RootName,
  admission: Admission | undefined,
  call: CallScope = { actor: currentActor(), standing: currentStanding() },
): boolean {
  const grants = manifest.permissions?.writePins;
  if (!Array.isArray(grants)) return false;
  const grant = grants.find(entry => entry?.root === root);
  if (
    grant === undefined ||
    typeof grant.capability !== 'string' ||
    !/^[a-z][a-z0-9]*(?:[-.:][a-z0-9]+)*$/u.test(grant.capability)
  )
    return false;
  const standing = call.standing;
  if (standing === undefined) return false;
  try {
    return (
      admission?.judgeRootWrite?.({
        plugin: manifest.id,
        root,
        capability: grant.capability,
        actor: call.actor,
        standing,
      }) === true
    );
  } catch {
    return false;
  }
}

/** A write pin never follows from a plugin's manifest alone, even on a loopback caller. */
export async function mintRootPin(
  pins: PinRegistry,
  plugin: string,
  path: string,
  options: PinOptions | undefined,
  readOnly: boolean,
  judge: (() => boolean) | undefined,
): Promise<UnjudgedRoot> {
  const asked = options?.write === true;
  const mayWrite = (): boolean => {
    try {
      return judge?.() === true;
    } catch {
      return false;
    }
  };
  if (asked && !mayWrite())
    throw new PermissionError(`${plugin} has no caller write authority on this pinned root.`, 'pin_write_required');
  return await pins.pin(plugin, path, options, asked || !readOnly ? 'write' : 'read', asked ? mayWrite : undefined);
}

/** A write view of an existing descriptor, with a final identity check of its original name before minting. */
export function withWritePin(
  held: HeldRoot,
  plugin: string,
  pins: PinRegistry,
  path: string,
  fs: HostFs,
  judge: (() => boolean) | undefined,
): HeldRoot {
  const write: NonNullable<HeldRoot['withWritePin']> = async use => {
    if (judge?.() !== true)
      throw new PermissionError(`${plugin} has no caller write authority on this pinned root.`, 'pin_write_required');
    const changed = () =>
      new PermissionError('The held folder changed before its write pin was requested.', 'pin_write_required');
    const current = await fs.openDirectory(path).catch(() => {
      throw changed();
    });
    try {
      const target = await held.open('', { wantDirectory: true });
      try {
        const identity = target.identities.at(-1);
        if (
          identity === undefined ||
          current.identity.device !== identity.dev ||
          current.identity.inode !== identity.ino
        )
          throw changed();
      } finally {
        await target.close();
      }
    } finally {
      await current.close();
    }
    return await pins.withWritePin(plugin, held.policyCwd, () => judge?.() === true, use);
  };
  return Object.freeze({ ...held, withWritePin: write });
}
