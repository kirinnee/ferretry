import { mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HeldGcRoot, IDaemonProcessPort, INixGcRootPort } from '../../lib/daemon/ports.ts';

/**
 * The Nix garbage-collection root, held through `nix-store`.
 *
 * `nix-store --add-root <link> --indirect --realise <store path>` writes a symbolic link at `<link>`
 * and registers it in `/nix/var/nix/gcroots/auto/`, so the store path survives
 * `nix-collect-garbage` for as long as the link exists. It is a per-user operation that needs no
 * privilege escalation and works the same on the macOS and Linux multi-user daemon installs.
 *
 * Nothing here throws. A pin is protection, not a precondition: an operator whose daemon is running
 * unpinned has a working daemon, and failing their install to tell them otherwise would trade a
 * hypothetical problem for a certain one.
 */
export class NixStoreGcRoot implements INixGcRootPort {
  constructor(private readonly processes: IDaemonProcessPort) {}

  async realPath(path: string): Promise<string> {
    // An unresolvable path is not a Nix path; the caller classifies it and moves on.
    return await realpath(path).catch(() => path);
  }

  /**
   * Which roots are in this directory, reported with the paths they were found at.
   *
   * Unreadable is answered as empty rather than as a failure: a directory that does not exist yet is
   * the ordinary first-run state, and one that cannot be listed leads the caller to REGISTER roots,
   * which is the safe direction. Nothing is filtered by shape — an entry here that no snapshot
   * accounts for is precisely what the caller has to be able to see and release.
   */
  async held(directory: string): Promise<readonly HeldGcRoot[]> {
    const names = await readdir(directory).catch(() => [] as string[]);
    return names.map(name => ({ name, path: join(directory, name) }));
  }

  async pin(storePath: string, rootPath: string): Promise<string | undefined> {
    try {
      await mkdir(dirname(rootPath), { recursive: true });
    } catch (error) {
      return `could not create ${dirname(rootPath)}: ${(error as Error).message}`;
    }
    // A stale root from an earlier install would make --add-root fail on an existing link.
    await rm(rootPath, { force: true }).catch(() => undefined);

    const outcome = await this.processes.run([
      'nix-store',
      '--add-root',
      rootPath,
      '--indirect',
      '--realise',
      storePath,
    ]);
    if (outcome.code === 127) return 'nix-store is not on PATH';
    if (outcome.code !== 0) {
      const detail = outcome.stderr.trim();
      return detail === '' ? `nix-store exited ${String(outcome.code)}` : detail;
    }
    return undefined;
  }

  async release(rootPath: string): Promise<void> {
    // Removing the link is the whole release: the entry Nix keeps in its auto-roots directory then
    // dangles, which Nix already treats as no longer a root. Nothing has to reach into /nix/var.
    await rm(rootPath, { force: true }).catch(() => undefined);
  }
}
