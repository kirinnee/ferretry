/**
 * `pins` (§3.2, §7.9): a data plugin's executable input is not pinned and not marked `floating: true`.
 *
 * - A **shell** item: a `flake` ref with its locked `rev` AND `narHash` (in the ref or a `lock` object), or a
 *   `packages` list on a `nixpkgs` pinned by `rev`.
 * - An **MCP** item: a `payload` that is an npm or PyPI package with its `integrity`, a binary with its `sha256`, a
 *   container `image` by `@sha256:` digest, or a remote `url` (runs nothing locally). A `command` with no payload is
 *   unpinned (`npx some-server@latest` fetches whatever is newest).
 *
 * Reads every `items` entry of kind `shell` or `mcp` in the workspace's manifests (JSON or YAML item files), and any
 * data-plugin folder passed with `--path <dir>` (its `items/**`), the way `fy plugin check <path>` will.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';

type Doc = Readonly<Record<string, unknown>>;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const obj = (value: unknown): Doc | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Doc) : undefined;

export function shellPinned(doc: Doc): boolean {
  const flake = str(doc.flake);
  if (flake !== undefined) {
    const lock = obj(doc.lock);
    const rev = /[?&]rev=[0-9a-f]{40}\b/.test(flake) || /^[0-9a-f]{40}$/.test(str(lock?.rev) ?? '');
    const narHash = /[?&]narHash=sha256-/.test(flake) || (str(lock?.narHash) ?? '').startsWith('sha256-');
    return rev && narHash;
  }
  if (Array.isArray(doc.packages)) {
    const nixpkgs = obj(doc.nixpkgs);
    return /^[0-9a-f]{40}$/.test(str(nixpkgs?.rev) ?? str(doc.nixpkgs) ?? '');
  }
  return false;
}

export function mcpPinned(doc: Doc): boolean {
  const payload = obj(doc.payload);
  if (payload === undefined) return str(doc.url) !== undefined && str(doc.command) === undefined;
  if (str(payload.url) !== undefined) return true;
  if ((str(payload.npm) ?? str(payload.pypi)) !== undefined)
    return /^sha(256|384|512)-/.test(str(payload.integrity) ?? '') && !/@latest$|@\^|@~/.test(str(payload.npm) ?? str(payload.pypi) ?? '');
  if (str(payload.binary) !== undefined) return /^[0-9a-f]{64}$/.test(str(payload.sha256) ?? '');
  if (str(payload.image) !== undefined) return /@sha256:[0-9a-f]{64}$/.test(str(payload.image) ?? '');
  return false;
}

export function pinFindings(kind: string, doc: Doc, where: string): Finding[] {
  if (doc.floating === true) return [];
  if (kind === 'shell' && !shellPinned(doc))
    return [{ check: 'pins', where, message: 'shell is not pinned: a flake needs rev and narHash, a package list a nixpkgs rev (or `floating: true`)' }];
  if (kind === 'mcp' && !mcpPinned(doc))
    return [{ check: 'pins', where, message: 'MCP server is not pinned: a payload with integrity, sha256, an image digest or a remote url (or `floating: true`)' }];
  return [];
}

export function readItem(file: string): Doc {
  const text = readFileSync(file, 'utf8');
  return (file.endsWith('.json') ? JSON.parse(text) : Bun.YAML.parse(text)) as Doc;
}

function kindFromPath(rel: string): string | undefined {
  return /(^|\/)(shells?|mcp)(\/|$)/.exec(rel)?.[2]?.replace(/s$/, '');
}

export const check: Check = {
  name: 'pins',
  summary: 'every executable input of a data plugin is pinned or marked floating',
  async run(ctx) {
    const findings: Finding[] = [];
    const model = await ctx.model();
    for (const s of model.loaded)
      for (const item of s.manifest.data?.items ?? []) {
        if (item.kind !== 'shell' && item.kind !== 'mcp') continue;
        const file = join(s.pkg.dir, item.file);
        const where = relative(model.ws.root, file).split(sep).join('/');
        if (!existsSync(file)) findings.push({ check: 'pins', where, message: 'item file is missing' });
        else findings.push(...pinFindings(item.kind, readItem(file), where));
      }
    const at = process.argv.indexOf('--path');
    const folder = at === -1 ? undefined : process.argv[at + 1];
    if (folder !== undefined)
      for (const rel of new Bun.Glob('items/**/*.{json,yaml,yml}').scanSync({ cwd: folder, onlyFiles: true })) {
        const kind = kindFromPath(rel);
        if (kind !== undefined) findings.push(...pinFindings(kind, readItem(join(folder, rel)), rel));
      }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2).filter((arg, i, all) => arg !== '--path' && all[i - 1] !== '--path'));
