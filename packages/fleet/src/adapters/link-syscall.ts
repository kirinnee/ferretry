import { dlopen, FFIType, type Pointer, read } from 'bun:ffi';
import { constants as osConstants } from 'node:os';
import { LIBC } from './directory-syscalls.ts';

/** Where the C library keeps this thread's `errno`, by the name each platform exports it under. */
const ERRNO = process.platform === 'darwin' ? '__error' : '__errno_location';

/**
 * The calls a folder step needs across TWO open folders — a hard link, and a rename, from a name in one to a name in
 * the other (`linkat`, `renameat`) — which no working directory can express. Integers and strings only, as
 * `directory-syscalls.ts` holds itself to — no struct.
 */
export interface LinkSyscall {
  /** Links `fromName` in the folder `fromFd` as `toName` in the folder `toFd`; throws with the errno's code. */
  linkat(fromFd: number, fromName: string, toFd: number, toName: string): void;
  /** Renames `fromName` in the folder `fromFd` to `toName` in the folder `toFd`; throws with the errno's code. */
  renameat(fromFd: number, fromName: string, toFd: number, toName: string): void;
}

const errnoNames = new Map(Object.entries(osConstants.errno).map(([name, value]) => [value, name]));

const cString = (text: string): Uint8Array => new TextEncoder().encode(`${text}\0`);

/** Loads `linkat`, `renameat` and the errno they set, or throws (see `loadDirectorySyscalls`). */
export function loadLinkSyscall(): LinkSyscall {
  const { symbols } = dlopen(LIBC, {
    linkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    [ERRNO]: { args: [], returns: FFIType.ptr },
  });
  const errnoOf = symbols[ERRNO] as () => Pointer | null;
  const refused = (verb: string, fromName: string, toName: string): never => {
    const at = errnoOf();
    const errno = at === null ? 0 : read.i32(at, 0);
    const code = errnoNames.get(errno) ?? `errno ${String(errno)}`;
    throw Object.assign(new Error(`${code}: ${verb} ${fromName} -> ${toName}`), { code, errno });
  };
  return {
    linkat: (fromFd, fromName, toFd, toName) => {
      if (symbols.linkat(fromFd, cString(fromName), toFd, cString(toName), 0) !== 0) refused('link', fromName, toName);
    },
    renameat: (fromFd, fromName, toFd, toName) => {
      if (symbols.renameat(fromFd, cString(fromName), toFd, cString(toName)) !== 0) refused('rename', fromName, toName);
    },
  };
}
