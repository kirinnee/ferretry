/**
 * Path decisions for the fleet.
 *
 * A portable account name such as `claude-work` resolves under the Ferretry-owned homes directory;
 * `~/.claude-work` remains an explicit opt-out for an operator who needs it. Profile assets are
 * relative to the fleet directory. Everything the provisioner touches must be absolute, so those
 * forms are expanded here — once, in one place, purely.
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

/**
 * One canonical spelling of a configured asset reference, so two spellings of one document compare
 * equal.
 *
 * `./CLAUDE.md` and `CLAUDE.md` are the same file, and the starter configuration writes the first
 * while a person editing it writes the second — so a raw string compare would report a fleet that
 * shares one document as two accounts sharing nothing. This collapses exactly the differences that
 * are decidable without a filesystem, which is why it lives here beside the other expansion rules.
 *
 * What it cannot decide is stated rather than hidden: `~/notes.md` and `/home/me/notes.md` may be one
 * file, and nothing pure can know that. Two references reaching one document by different roots stay
 * two documents to every caller of this.
 */
export function canonicalAssetReference(reference: string): string {
  return normalize(reference);
}

/** Join a directory to a child name without doubling or dropping the separator. */
export function joinPath(directory: string, name: string): string {
  return join(directory, name);
}
