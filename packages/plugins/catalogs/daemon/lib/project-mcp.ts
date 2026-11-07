import { posix } from 'node:path';
export { McpProjectFileChanged, type McpProjectFiles } from '../../contract/items/index.ts';
const withoutTrailingSlash = (path: string): string => posix.normalize(path).replace(/(?<=.)\/+$/u, '');

export const projectRootFor = (cwd: string, roots: readonly string[]): string | undefined => {
  const target = withoutTrailingSlash(cwd);
  return roots
    .map(withoutTrailingSlash)
    .filter(root => target === root || target.startsWith(root === '/' ? '/' : `${root}/`))
    .sort((left, right) => right.length - left.length)[0];
};
export type { McpProjectFileReading } from '../../contract/items/index.ts';
