import { isAbsolute, normalize, sep } from 'node:path';

/**
 * The Nix store prefix. A store path is `/nix/store/<hash>-<name>`, and everything below one belongs
 * to it: `/nix/store/<hash>-ferretry/bin/fyd` is part of the `<hash>-ferretry` output.
 */
const STORE_ROOT = `${sep}nix${sep}store${sep}`;

/**
 * A store directory name: 32 characters of Nix's base32 hash, a dash, then the derivation name.
 *
 * Matched rather than assumed. `/nix/storefront/bin/fyd` and a `/nix/store` with nothing under it
 * are not store paths, and treating them as one would send `nix-store` a path it would reject.
 */
const STORE_NAME = /^[0-9a-z]{32}-[^/]+$/;

/**
 * The Nix store path an executable belongs to, or `undefined` when it does not come from the store.
 *
 * Callers must pass a REAL path, with symbolic links already resolved. `nix profile install` puts
 * `~/.nix-profile/bin/fy` on `PATH` and `nix shell` puts the store path itself there; only the
 * resolved path tells the two apart from a Homebrew or GoReleaser install, and only the store case
 * can be garbage-collected out from under a running service.
 */
export function nixStorePathOf(resolvedBinary: string): string | undefined {
  if (!isAbsolute(resolvedBinary)) return undefined;
  const path = normalize(resolvedBinary);
  if (!path.startsWith(STORE_ROOT)) return undefined;
  const name = path.slice(STORE_ROOT.length).split(sep)[0] ?? '';
  return STORE_NAME.test(name) ? `${STORE_ROOT}${name}` : undefined;
}
