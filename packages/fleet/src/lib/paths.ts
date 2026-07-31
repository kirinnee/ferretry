/**
 * Path decisions for the fleet.
 *
 * Configuration is written by a human, so it says `~/.claude-work` rather than an absolute path,
 * and it names profile assets relative to the fleet directory. Everything the provisioner touches
 * must be absolute, so those two forms are expanded here — once, in one place, purely.
 *
 * No filesystem, no `process`, no `os.homedir()`: the user's home and the assets root are supplied
 * by the caller, which is what lets a test point the whole fleet at a temporary directory.
 */
import { isAbsolute, join, normalize } from 'node:path';

const HOME_PREFIXES = ['~/', '$HOME/'] as const;
const HOME_ALIASES = ['~', '$HOME'] as const;

/**
 * Expand a configured path against `userHome`. A leading `~/` or `$HOME/` is the user's home; an
 * already-absolute path is returned normalized; anything else is relative to `base`.
 *
 * `..` is *not* rejected here — `SafeNameSchema` guards the segments a configuration may invent,
 * and the provisioner enforces the write boundary with a resolved-path containment check. This
 * function only normalizes.
 */
export function expandPath(value: string, userHome: string, base: string): string {
  for (const alias of HOME_ALIASES) {
    if (value === alias) return normalize(userHome);
  }
  for (const prefix of HOME_PREFIXES) {
    if (value.startsWith(prefix)) return normalize(join(userHome, value.slice(prefix.length)));
  }
  return normalize(isAbsolute(value) ? value : join(base, value));
}

/** An account home. Relative homes are resolved against the fleet's homes directory. */
export function expandHomePath(value: string, userHome: string, homesDirectory: string): string {
  return expandPath(value, userHome, homesDirectory);
}

/** A profile asset reference. Relative references are resolved against the assets directory. */
export function expandAssetPath(value: string, userHome: string, assetsDirectory: string): string {
  return expandPath(value, userHome, assetsDirectory);
}

/** Join a directory to a child name without doubling or dropping the separator. */
export function joinPath(directory: string, name: string): string {
  return join(directory, name);
}
