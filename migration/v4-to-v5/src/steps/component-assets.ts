/**
 * A carried settings or hooks document that points at a file under v4's `fleet/assets/` (the owner's `PreCompact` hook
 * is `cat <v4 home>/fleet/assets/components/hooks/compact-before.txt`, `SessionStart` is `sh <…>/compact-after.sh`).
 *
 * The rule (lead ruling 2026-11-09), applied to every STRING value of the carried body:
 *
 * 1. A whole path TOKEN (bounded by the start or end of the value, whitespace or a quote; never a piece of a longer
 *    path) that names a file under `<v4 home>/fleet/assets/` (the absolute v4 home, or `~/…`, `$HOME/…`, `${HOME}/…`
 *    when that resolves to the v4 home) is carried by (a) carrying the FILE into the v5 home at the SAME relative path
 *    under `fleet/assets/`, under the rules every component file has (`componentFileSource`: `lstat` on every folder
 *    and the file, no link, `nlink === 1`, a regular file; 1 MiB cap; the secret refusal on its content), and (c)
 *    rewriting only that token to the v5 copy.
 * 2. The file is refused when its CONTENT itself names the v4 home (a script that reaches back into v4 is never
 *    carried silently).
 * 3. Anything else in the document that names the v4 home (a path outside `fleet/assets/`, a folder, a missing file,
 *    a file that fails a rule) is NOT carried: the reasons name the field and the kind of refusal, never the value.
 *
 * The file keeps only its owner mode bits (an executable script stays executable; never wider than the source).
 *
 * WHERE: v5 Runtimes reads its asset tree at `join(paths.fleet, 'assets')` (the skill-folders step writes there too).
 * Nothing in v5 sweeps, prunes or refuses a file under it: the runtimes adapters only read it through a root scoped to
 * `assets/` (`fleet-disk.ts`, `fleet-home-reader.ts`, `root-host-files.ts`), and the kernel never refuses a folder it
 * has not declared.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { rawSecretPaths } from '../v4/config.ts';
import { componentFileSource, MAX_COMPONENT_BYTES } from './component-files.ts';
import type { StepContext } from './index.ts';

/** A file to carry: its snapshot source, its path under `fleet/assets/`, and its owner mode bits. */
export interface CarriedAsset {
  /** Relative to `fleet/assets/` (also relative to the v5 home's `fleet/assets/`). */
  readonly rel: string;
  readonly source: string;
  /** `mode & 0o700` of the source: never wider than it. */
  readonly mode: number;
}

export interface AssetRewrite {
  readonly value: unknown;
  readonly assets: readonly CarriedAsset[];
  /** One per field that could not be carried: the field name and the kind of refusal, never a value. */
  readonly reasons: readonly string[];
}

/** Where a carried asset lands in the v5 home. */
export const v5AssetPath = (rel: string): string => join('fleet', 'assets', rel);

const REMEDY = 'copy the file under fleet/assets in v4, or remove the hook';
const HOME_FORMS = ['~', '$HOME', '${HOME}'] as const;
const TOKEN_BREAKS = /([\s"'`]+)/u;

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `needle` followed by anything that ends a path component (`<v4 home>-old` is another folder). */
function namesWhole(text: string, needle: string): boolean {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const next = text[at + needle.length];
    if (next === undefined || !/[\w.-]/u.test(next)) return true;
  }
  return false;
}

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** Every way a value can spell v4's home, longest first. */
async function v4Spellings(ctx: StepContext): Promise<readonly string[]> {
  const real = normalize(ctx.previewV4Home ?? ctx.v4.home);
  const spellings = new Set<string>([real, normalize(ctx.v4.home)]);
  const resolved = await realpath(real).catch(() => undefined);
  if (resolved !== undefined) spellings.add(resolved);
  const relatives = new Set<string>(['.ferretry']);
  const userHome = ctx.previewUserHome ?? ctx.host?.homeDirectory;
  if (userHome !== undefined) {
    const inside = relative(userHome, real);
    if (inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
      relatives.add(inside);
  }
  for (const rel of relatives) for (const form of HOME_FORMS) spellings.add(`${form}/${rel}`);
  return [...spellings].filter(spelling => spelling !== '').sort((a, b) => b.length - a.length);
}

/** Whether a text names the v4 home (whole), as written or URL-decoded. */
const namesV4 = (text: string, spellings: readonly string[]): boolean =>
  [text, decoded(text)].some(form => spellings.some(spelling => namesWhole(form, spelling)));

/** Text that looks like it holds a credential (a known key shape, a private key, or `NAME_KEY=<high-entropy>`). */
function looksLikeCredential(bytes: Buffer): boolean {
  const text = bytes.toString('latin1');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text)) return true;
  const values: string[] = [];
  const assigned: Record<string, string> = {};
  for (const word of text.split(/\s+/u)) if (word !== '') values.push(word);
  for (const match of text.matchAll(/([A-Za-z0-9_.-]+)\s*[=:]\s*["']?([^\s"']+)/gu))
    assigned[match[1] as string] = match[2] as string;
  return rawSecretPaths({ values, ...assigned }).length > 0;
}

/** Why a file under `fleet/assets/` cannot be carried, or the asset itself. */
async function assetFor(ctx: StepContext, token: string, spellings: readonly string[]): Promise<CarriedAsset | string> {
  const found = await componentFileSource(ctx, token.replace(/^\$\{HOME\}/u, '$HOME'));
  if (!('source' in found))
    return found.refused === 'a hard link' ? 'a hard link' : 'not a plain file (a link, a folder or a missing file)';
  const rel = relative(join(ctx.v4.home, 'fleet', 'assets'), found.source)
    .split(sep)
    .join('/');
  // The skill-folders step carries `fleet/assets/skills/` whole, under its own rules; one file is never written twice.
  if (rel === 'skills' || rel.startsWith('skills/')) return 'inside the skill folders, which have their own step';
  const facts = await lstat(found.source).catch(() => undefined);
  if (facts === undefined || !facts.isFile()) return 'not a plain file (a link, a folder or a missing file)';
  if (facts.size > MAX_COMPONENT_BYTES) return `over ${MAX_COMPONENT_BYTES / 1024 / 1024} MiB`;
  const bytes = await readFile(found.source).catch(() => undefined);
  if (bytes === undefined) return 'unreadable';
  if (namesV4(bytes.toString('latin1'), spellings)) return 'its content names the v4 home';
  if (looksLikeCredential(bytes)) return 'its content looks like a credential';
  return { rel, source: found.source, mode: facts.mode & 0o700 };
}

/**
 * `value` with every path token naming a file under v4's `fleet/assets/` rewritten to its v5 copy, the files to carry,
 * and one reason per field that could not be carried. The reasons never hold a value.
 */
export async function carryAssetReferences(ctx: StepContext, value: unknown): Promise<AssetRewrite> {
  const spellings = await v4Spellings(ctx);
  const assets = new Map<string, CarriedAsset>();
  const reasons: string[] = [];
  const refuse = (field: string, why: string): void => {
    reasons.push(`${field} ${why}; ${REMEDY}`);
  };

  const rewriteString = async (text: string, field: string): Promise<string> => {
    if (!namesV4(text, spellings)) return text;
    let failed = false;
    const parts = text.split(TOKEN_BREAKS);
    for (const [index, token] of parts.entries()) {
      if (index % 2 === 1 || token === '') continue;
      const spelling = spellings.find(item => token.startsWith(`${item}/fleet/assets/`));
      if (spelling === undefined) continue;
      const result = await assetFor(ctx, token, spellings);
      if (typeof result === 'string') {
        failed = true;
        refuse(field, `names a file under the v4 home's fleet/assets that was not carried (${result})`);
        continue;
      }
      assets.set(result.rel, result);
      parts[index] = ctx.v5.resolve(v5AssetPath(result.rel));
    }
    const rewritten = parts.join('');
    if (!failed && namesV4(rewritten, spellings))
      refuse(field, 'names the v4 home outside a plain file under its fleet/assets');
    return rewritten;
  };

  const visit = async (node: unknown, field: string): Promise<unknown> => {
    if (typeof node === 'string') return rewriteString(node, field);
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const [index, item] of node.entries()) out.push(await visit(item, `${field}[${index}]`));
      return out;
    }
    if (isRecordValue(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) {
        if (namesV4(key, spellings))
          refuse(field === '' ? '<path key>' : `${field}.<path key>`, 'has a key that names the v4 home');
        const label = key.includes('/') ? '<path key>' : key;
        out[key] = await visit(item, field === '' ? label : `${field}.${label}`);
      }
      return out;
    }
    return node;
  };

  const rewritten = await visit(value, '');
  return { value: rewritten, assets: [...assets.values()], reasons };
}
