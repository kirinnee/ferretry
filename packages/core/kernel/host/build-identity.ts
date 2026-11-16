import { stat } from 'node:fs/promises';

/**
 * WHICH BUILD OF THE DAEMON THIS IS, beyond its semver. Two dev builds can share a version yet build a projection
 * differently, and a conditional tag the app holds across such an upgrade must not be answered `304`.
 *
 * It is read from the build itself, once, never from the process: the size and mtime of the compiled executable
 * (`process.execPath`; a compiled entry's `Bun.main` is a virtual path that has no file) or, running from source, of
 * the entry script. The same build gives the same value on every start, so the unchanged `304` keeps saving; a new
 * binary gives a new one. No build define: a release-only define is what once made two pipelines disagree.
 */
export async function executableIdentity(
  candidates: readonly string[] = [Bun.main, process.execPath],
  statOf: (path: string) => Promise<{ readonly size: number; readonly mtimeMs: number }> = stat,
): Promise<string> {
  for (const path of candidates) {
    try {
      const { size, mtimeMs } = await statOf(path);
      return `${size.toString(36)}.${Math.floor(mtimeMs).toString(36)}`;
    } catch {
      // a virtual or missing path names no file; the next candidate may
    }
  }
  return 'unidentified';
}
