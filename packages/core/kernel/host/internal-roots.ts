import type { RootName } from '../contract/ports.ts';

/**
 * The roots the kernel makes under the home, as `<home>/state/<plugin>/<name>`. One fact, two readers: the roots
 * module (the base it makes and serves) and the state port (a collection listed at the top of a plugin's state folder
 * never reports one of these folders as one of its names).
 */
export const INTERNAL_ROOT_FOLDERS: readonly RootName[] = Object.freeze([
  'agent-homes',
  'downloads',
  'credentials',
  'sessions',
]);

const INTERNAL: ReadonlySet<string> = new Set(INTERNAL_ROOT_FOLDERS);

/** Whether a root is one the kernel makes under the home (it has an internal base), not an owner's or an outside one. */
export function isInternalRoot(name: RootName): boolean {
  return INTERNAL.has(name);
}

/**
 * The internal roots the kernel makes at a FIXED place under the home, one for the whole daemon rather than one per
 * plugin under `state/<plugin>/`: `fleet` is `<home>/fleet` (today's fleet folder, already one of the fence's pinned
 * paths, so no owner's root ever reaches it). Each is held by one plugin alone (`host/roots.ts`, `ROOT_OWNERS`).
 */
export const HOME_ROOT_FOLDERS: Readonly<Partial<Record<RootName, string>>> = Object.freeze({ fleet: 'fleet' });

/** Whether a root is one the kernel makes and serves under the home: per plugin, or at a fixed place. */
export function isKernelMadeRoot(name: RootName): boolean {
  return isInternalRoot(name) || HOME_ROOT_FOLDERS[name] !== undefined;
}

/**
 * Whether a folder name directly inside a plugin's state folder is a kernel-made root's base. Case-INSENSITIVE: on a
 * case-insensitive disk (macOS APFS) `Sessions` is the folder `sessions`, so the comparison must not tell them
 * apart. Every root name is ASCII, so ASCII lowercasing is the whole fold.
 */
export function isInternalRootFolder(name: string): boolean {
  return INTERNAL.has(name.toLowerCase());
}
