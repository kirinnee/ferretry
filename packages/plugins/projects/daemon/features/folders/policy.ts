import { belowHome, isAtOrUnder, isPrivateFolder, privateSpellings } from './fence.ts';
import type { FolderBrowser, FolderVerdict } from './port.ts';

/** The policy for ONE request: the verdict on a real path, and whether a real path is a private folder (a link to one included). */
export interface FolderPolicy {
  /** The full verdict: home or below, not private, and no folder from the home down to this one holds a sign-in file. */
  readonly verdict: FolderVerdict;
  /**
   * The verdict for a folder directly inside one that `verdict` already accepted: the same judgment, with the ancestors not
   * asked again (they are the parent's, already proved), so a wide folder costs one sign-in look per child, not one per
   * ancestor per child.
   */
  readonly child: FolderVerdict;
  /** Whether a real path is at or under where any private folder REALLY is. */
  readonly isPrivateReal: (real: string) => boolean;
}

/**
 * The ONE privacy policy every folder reader shares (the explorer and the repository scan): the real path (never the
 * spelling alone) is the home or below it, is not a private folder (by name, and by where each private folder REALLY is:
 * `~/.gnupg` linked to `~/dotfiles/gnupg` makes both private), and no folder from the first below the home down to it holds
 * a sign-in file (the home itself often does and is the starting point). Where each private folder really is is read once.
 */
export async function folderPolicy(browser: FolderBrowser, home: string): Promise<FolderPolicy> {
  const roots = await browser.realPaths(privateSpellings(home));
  const isPrivateReal = (real: string): boolean => roots.some(root => isAtOrUnder(real, root));
  const judge = async (real: string, signInOf: (below: readonly string[]) => Promise<boolean>) => {
    const below = belowHome(real, home);
    if (below === undefined) return 'outside' as const;
    if (isPrivateFolder(below) || isPrivateReal(real)) return 'private' as const;
    return (await signInOf(below)) ? ('private' as const) : undefined;
  };
  const verdict: FolderVerdict = real =>
    judge(real, async below => {
      let path = home.replace(/\/+$/, '');
      for (const segment of below) {
        path = `${path}/${segment}`;
        if (await browser.holdsSignIn(path)) return true;
      }
      return false;
    });
  const child: FolderVerdict = real =>
    judge(real, async below => below.length > 0 && (await browser.holdsSignIn(real)));
  return { verdict, child, isPrivateReal };
}
