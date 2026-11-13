/**
 * The release hash compare (§9.6): regenerates every effective contract hash and compares it with the last release's
 * `contract-hashes.json`, so the release notes list each plugin whose hash changed and the "update this daemon" line
 * is never a surprise.
 *
 *   bun scripts/gen/hash-compare.ts <previous contract-hashes.json> [--root <dir>] [--markdown]
 *
 * Prints one line per changed, added or removed package (or a Markdown section with `--markdown`). It never fails a
 * build: a changed hash is news, not an error. Exit 2 only when the previous file cannot be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ContractHashes, compareHashes } from './lib/hashes.ts';
import { buildModel } from './registries.ts';

export function readHashes(text: string): Record<string, ContractHashes> {
  const value = JSON.parse(text) as { format?: unknown; hashes?: Record<string, ContractHashes> };
  if (value.format !== 1 || value.hashes === undefined) throw new Error('not a format-1 contract-hashes.json');
  return value.hashes;
}

export function releaseNotes(diff: ReturnType<typeof compareHashes>): string {
  const lines = ['### Contract changes', ''];
  if (diff.changed.length + diff.added.length + diff.removed.length === 0)
    return `${lines.join('\n')}No plugin's contract changed.\n`;
  for (const id of diff.changed)
    lines.push(`- **${id}** changed: a daemon on the previous release shows "Update this daemon" for it.`);
  for (const id of diff.added) lines.push(`- **${id}** is new.`);
  for (const id of diff.removed) lines.push(`- **${id}** was removed.`);
  return `${lines.join('\n')}\n`;
}

async function main(args: readonly string[]): Promise<number> {
  const previousPath = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--root');
  const rootAt = args.indexOf('--root');
  const root = rootAt === -1 ? join(import.meta.dir, '..', '..') : (args[rootAt + 1] as string);
  if (previousPath === undefined || !existsSync(previousPath)) {
    console.error('usage: bun scripts/gen/hash-compare.ts <previous contract-hashes.json> [--markdown]');
    return 2;
  }
  let previous: Record<string, ContractHashes>;
  try {
    previous = readHashes(readFileSync(previousPath, 'utf8'));
  } catch (error) {
    console.error(`${previousPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const model = await buildModel(root);
  const diff = compareHashes(previous, Object.fromEntries(model.hashes));
  if (args.includes('--markdown')) process.stdout.write(releaseNotes(diff));
  else {
    for (const id of diff.changed) console.log(`changed\t${id}`);
    for (const id of diff.added) console.log(`added\t${id}`);
    for (const id of diff.removed) console.log(`removed\t${id}`);
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
