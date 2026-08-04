import { dlopen, FFIType, suffix } from 'bun:ffi';

/**
 * The two C calls a pinner needs that this runtime does not expose, and nothing else.
 *
 * WHY FFI AT ALL. Confining reads to a directory requires opening each component FROM an already-open
 * parent. POSIX spells that `openat`; this runtime's filesystem API has no such call and takes only
 * pathnames. What it DOES honour is the kernel's own working directory: with a held directory
 * installed, a one-segment relative name is resolved by the kernel from that directory, which is
 * `openat` by another spelling. So the missing primitive is not `openat` itself — it is `fchdir`, the
 * only way to install a descriptor as that directory.
 *
 * `getcwd` is here for the same reason: it reports the kernel's path for the directory actually
 * installed, which is how a pinned root learns its own real location without trusting the name it was
 * configured with. The runtime's own `cwd` answer is a cached JavaScript string and does NOT move when
 * the kernel's does — the reason this is a C call rather than a library one.
 *
 * WHY SO SMALL A SURFACE. Two calls taking integers and a byte buffer, with no struct layouts, are the
 * same shape on every POSIX system. Reaching for `openat`, `fdopendir` and `readdir` instead would
 * mean hand-decoding `struct dirent`, whose layout, field order and even symbol name differ between
 * Linux, macOS on Apple silicon and macOS on Intel — a decoding mistake there yields plausible
 * garbage rather than an error, and no test on one platform can catch it on another.
 */

/** The C library this runtime is already linked against, under the name its loader answers to. */
const LIBC = process.platform === 'darwin' ? 'libSystem.B.dylib' : `libc.${suffix}.6`;

export interface DirectorySyscalls {
  /** Installs an open directory as the kernel's working directory. Returns 0, or -1 on failure. */
  fchdir(fd: number): number;
  /** The kernel's own absolute path for the directory currently installed. */
  currentDirectory(): string;
}

/** Longest path the kernel will report. `PATH_MAX` is 4096 on Linux and 1024 on macOS. */
const MAX_PATH_BYTES = 4096;

/**
 * Loads the two calls, or throws.
 *
 * A THROW IS THE CORRECT OUTCOME on a runtime or platform where they cannot be reached: the caller
 * turns it into "this daemon cannot browse files here", which is honest, rather than falling back to
 * pathname checks, which would be a viewer that claims a containment it does not have.
 */
export function loadDirectorySyscalls(): DirectorySyscalls {
  const { symbols } = dlopen(LIBC, {
    fchdir: { args: [FFIType.i32], returns: FFIType.i32 },
    getcwd: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
  });
  return {
    fchdir: symbols.fchdir as (fd: number) => number,
    currentDirectory: () => {
      const buffer = new Uint8Array(MAX_PATH_BYTES);
      if (!symbols.getcwd(buffer, BigInt(buffer.byteLength)))
        throw new Error('the kernel would not report the current directory');
      const end = buffer.indexOf(0);
      return new TextDecoder().decode(buffer.subarray(0, end < 0 ? buffer.byteLength : end));
    },
  };
}
