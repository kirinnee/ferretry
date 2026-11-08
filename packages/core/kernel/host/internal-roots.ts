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

/** Whether a folder name directly inside a plugin's state folder is a kernel-made root's base. */
export function isInternalRootFolder(name: string): boolean {
  return INTERNAL.has(name);
}
