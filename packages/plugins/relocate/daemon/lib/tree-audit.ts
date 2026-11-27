import { CheckoutError } from './checkout.ts';

type Git = (args: readonly string[], stdin?: Uint8Array) => Promise<Uint8Array>;
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/** Paths in a Git tree are inert data until every component and mode has been checked. */
function safePath(path: string): boolean {
  return (
    path !== '' &&
    path.length <= 1024 &&
    !/[\\\p{Cc}]/u.test(path) &&
    path
      .split('/')
      .every(
        part => part !== '' && part !== '.' && part !== '..' && !['.git', '.gitmodules'].includes(part.toLowerCase()),
      )
  );
}

function targetOf(path: string, target: string, links: ReadonlyMap<string, string>): string {
  if (target === '' || target.startsWith('/') || /[\\\p{Cc}]/u.test(target))
    throw new CheckoutError('a moved symlink leaves its tree');
  const parts = path.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') {
      if (parts.pop() === undefined) throw new CheckoutError('a moved symlink leaves its tree');
    } else if (part !== '' && part !== '.') {
      parts.push(part);
      // Judge the original walk BEFORE a later `..` could erase a symlink hop.
      if (links.has(parts.join('/'))) throw new CheckoutError('chained moved symlinks cannot be audited safely');
    }
  }
  const resolved = parts.join('/');
  if (!safePath(resolved)) throw new CheckoutError('a moved symlink names a protected path');
  return resolved;
}

/** Audit history AND the index after Git's own confined patch parser, before writing any working files. */
export async function auditTree(git: Git, head: string, diff?: Uint8Array): Promise<void> {
  await git(['-c', 'fsck.badFilemode=error', 'fsck', '--strict', '--full', '--no-reflogs']);
  const revisions = decode(await git(['rev-list', '--max-count=513', head]))
    .trim()
    .split('\n');
  if (revisions.length > 512) throw new CheckoutError('the moved history is too large to audit');
  const check = async (tree: string) => {
    const records = decode(await git(['ls-tree', '-r', '-z', tree]))
      .split('\0')
      .filter(Boolean);
    if (records.length > 20_000) throw new CheckoutError('the moved tree has too many paths');
    const links = new Map<string, string>();
    for (const record of records) {
      const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(record);
      if (match === null || !safePath(match[3] ?? ''))
        throw new CheckoutError('the moved tree contains an unsafe path, mode or submodule');
      if (match[1] === '120000') {
        const path = match[3] as string;
        links.set(path, decode(await git(['cat-file', 'blob', match[2] as string])));
      }
    }
    for (const [path, target] of links) targetOf(path, target, links);
  };
  for (const revision of revisions) await check(revision);
  await git(['read-tree', head]);
  if (diff !== undefined) {
    if (/^(?:old mode|new mode|new file mode|deleted file mode) (?!100644$|100755$|120000$)/mu.test(decode(diff)))
      throw new CheckoutError('the moved patch contains an unsupported mode');
    await git(['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], diff);
    await check(decode(await git(['write-tree'])).trim());
  }
  await git(['read-tree', head]);
}
