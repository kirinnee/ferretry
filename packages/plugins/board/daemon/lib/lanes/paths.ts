import { posix } from 'node:path';

const withoutTrailingSlash = (path: string): string => posix.normalize(path).replace(/(?<=.)\/+$/u, '');

/** The longest root that is `cwd` or contains it, lexically. */
export const projectRootFor = (cwd: string, roots: readonly string[]): string | undefined => {
  const target = withoutTrailingSlash(cwd);
  return roots
    .map(withoutTrailingSlash)
    .filter(root => target === root || target.startsWith(root === '/' ? '/' : `${root}/`))
    .sort((left, right) => right.length - left.length)[0];
};
