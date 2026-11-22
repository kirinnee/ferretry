import {
  belowHome,
  isAtOrUnder,
  isDeniedName,
  isOtherHome,
  isPrivateBelowHome,
  isSkippedTree,
  privateSpellings,
} from './fence.ts';
import type { FolderBrowser, FolderVerdict } from './port.ts';

/** The policy for ONE request: the verdict on a real path, and whether a real path is a private folder (a link to one included). */
export interface FolderPolicy {
  /**
   * The full verdict on a real path, anywhere on the disk: not in a skipped tree (`outside`), not private (`private`: a
   * private folder by name or by where it REALLY is, another user's home, the macOS `~/Library`), and no folder from the first
   * below the anchor down to it holds a sign-in file. The anchor is the home for a path inside it and `/` for one outside
   * (the home itself often holds a sign-in file and is the starting point; `/` is not a place that has one).
   */
  readonly verdict: FolderVerdict;
  /**
   * The verdict for a folder directly inside one that `verdict` already accepted: the same judgment, with the ancestors not
   * asked again (they are the parent's, already proved), so a wide folder costs one sign-in look per child, not one per
   * ancestor per child.
   */
  readonly child: FolderVerdict;
  /** `verdict`, but a place outside the home is `outside` and the outside-home gate is never asked: what a folder is MADE in. */
  readonly confined: FolderVerdict;
  /** Whether a real path is at or under where any private folder REALLY is, or is in another user's home. */
  readonly isPrivateReal: (real: string) => boolean;
  /** Whether a real path is in a tree a project is never read from (pseudo filesystems, the nix store, …). */
  readonly isSkippedReal: (real: string) => boolean;
  /** Asks the outside-home gate, once per request (a no-op without one): called before the disk is touched for a path named outside the home. */
  readonly enterOutside: () => Promise<void>;
}

/**
 * The ONE privacy policy every folder reader shares (the explorer and the repository scan): the real path (never the
 * spelling alone) is not in a skipped tree, is not a private folder (by name, and by where each private folder REALLY is:
 * `~/.gnupg` linked to `~/dotfiles/gnupg` makes both private) or another user's home, and no folder from the first below the
 * anchor down to it holds a sign-in file. Where each private folder really is is read once.
 *
 * It does not fence the home: a project can be anywhere. `outsideHome` is what a reader that is NOT the owner at the
 * machine must pass to look at a place outside it (a remote device needs `filesystem.configure`): it is asked once per
 * request, before anything else is said about a real path outside the home, and a refusal is the error it throws. The
 * repository scan hands it the same gate for the project folder's RESOLVED place; a reader with no gate has none.
 */
export async function folderPolicy(
  browser: FolderBrowser,
  home: string,
  outsideHome?: () => Promise<void>,
): Promise<FolderPolicy> {
  const roots = await browser.realPaths(privateSpellings(home));
  const isPrivateReal = (real: string): boolean =>
    roots.some(root => isAtOrUnder(real, root)) || isOtherHome(real, home);
  const isSkippedReal = (real: string): boolean => isSkippedTree(real, home);
  let asked: Promise<void> | undefined;
  const enterOutside = (): Promise<void> => {
    if (outsideHome === undefined) return Promise.resolve();
    asked ??= outsideHome();
    return asked;
  };
  const judge = async (real: string, signInOf: (segments: readonly string[], anchor: string) => Promise<boolean>) => {
    const below = belowHome(real, home);
    if (below === undefined) await enterOutside();
    if (isSkippedReal(real)) return 'outside' as const;
    if ((below !== undefined && isPrivateBelowHome(below)) || isPrivateReal(real)) return 'private' as const;
    const segments = below ?? real.split('/').filter(segment => segment !== '');
    // The shared name list on every real path component (below the home, or from `/` outside it): `/srv/.ssh` is no softer
    // than `~/.ssh`, and the sign-in marker alone would miss a key store that holds none.
    if (segments.some(isDeniedName)) return 'private' as const;
    return (await signInOf(segments, below === undefined ? '' : home.replace(/\/+$/, '')))
      ? ('private' as const)
      : undefined;
  };
  const verdict: FolderVerdict = real =>
    judge(real, async (segments, anchor) => {
      let path = anchor;
      for (const segment of segments) {
        path = `${path}/${segment}`;
        if (await browser.holdsSignIn(path)) return true;
      }
      return false;
    });
  const child: FolderVerdict = real =>
    judge(real, async segments => segments.length > 0 && (await browser.holdsSignIn(real)));
  const confined: FolderVerdict = async real => (belowHome(real, home) === undefined ? 'outside' : verdict(real));
  return { verdict, child, confined, isPrivateReal, isSkippedReal, enterOutside };
}
