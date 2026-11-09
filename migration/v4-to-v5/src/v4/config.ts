/**
 * Reading v4's `config/` folder: which file is which, and each YAML file as an owner-edited `yaml` Document (comments
 * and key order kept). A LOCAL copy of v4's grammar on purpose — v5 has no v4 reader. Sources, at 4.291.5:
 * `packages/protocol/src/lib/config-files.ts` (`classifyConfigPath`, the singleton and folder names, 256 KiB cap) and
 * `packages/fleet/src/lib/config-files/kinds.ts` (one schema per kind).
 *
 * Every failure is a {@link V4InputError} naming the file (relative to the v4 home) and, for a value, its key path —
 * never the text: a YAML parser's own message quotes the line it choked on, so it is never passed through.
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { type Document, isMap, isScalar, LineCounter, parseDocument, type YAMLMap } from 'yaml';
import { V4InputError } from './documents.ts';
import type { V4ConfigOverrides, V4Paths } from './layout.ts';

/** The singleton files at the top of `config/` (`SINGLETON_FILES`). */
export const V4_SINGLETONS = {
  machine: 'machine.yaml',
  warden: 'warden.yaml',
  learning: 'learning.yaml',
  voice: 'voice.yaml',
  pack: 'pack.yaml',
  limits: 'limits.yaml',
  modelsGuide: 'models-guide.yaml',
  accountDefaults: 'account-defaults.yaml',
} as const;
export type V4Singleton = keyof typeof V4_SINGLETONS;

/** The folders of named files (`NAMED_DIRECTORIES`). */
export const V4_NAMED = {
  login: 'logins',
  profile: 'profiles',
  runtime: 'runtimes',
  preset: 'presets',
  models: 'models',
} as const;
export type V4Named = keyof typeof V4_NAMED;

/** `config/components/<kind>/<name>.yaml` (`CONFIG_COMPONENT_KINDS`). */
export const V4_COMPONENT_KINDS = ['instructions', 'mcp', 'skills', 'settings', 'hooks', 'modelSets'] as const;
export type V4ComponentKind = (typeof V4_COMPONENT_KINDS)[number];

export type V4ConfigAddress =
  | { readonly kind: V4Singleton }
  | { readonly kind: V4Named; readonly name: string }
  | { readonly kind: 'component'; readonly componentKind: V4ComponentKind; readonly name: string };

export interface V4ConfigFile {
  readonly address: V4ConfigAddress;
  /** Relative to the v4 home, e.g. `config/runtimes/claude-work.yaml`: how every message names it. */
  readonly label: string;
  readonly path: string;
  /** The text to read instead of the file on disk (an override, see {@link V4ConfigOverrides}); the disk is not touched. */
  readonly text?: string;
}

/**
 * One config file as the steps read it: with its override text when the run has one for that label. The ONE place a step
 * names a config file it did not find by listing (Packs, Lessons).
 */
export const v4ConfigFile = (v4: V4Paths, address: V4ConfigAddress, label: string): V4ConfigFile => {
  const text = v4.configOverrides?.get(label);
  return { address, label, path: join(v4.home, label), ...(typeof text === 'string' ? { text } : {}) };
};

/** `undefined`: no override for the label (read the disk); `null`: it reads as absent; else the text it reads as. */
export const v4ConfigOverride = (v4: V4Paths, label: string): string | null | undefined =>
  v4.configOverrides?.get(label);

const bySegments = (a: V4ConfigFile, b: V4ConfigFile): number => {
  const left = a.label.split('/');
  const right = b.label.split('/');
  for (let n = 0; n < Math.min(left.length, right.length); n++) {
    const l = left[n] as string;
    const r = right[n] as string;
    if (l !== r) return l < r ? -1 : 1;
  }
  return left.length - right.length;
};

/** v4's `MAX_CONFIG_FILE_BYTES` (`packages/daemon/src/adapters/config-files/files.ts`): a bigger file never loaded. */
const MAX_BYTES = 256 * 1024;

/** v4's `usableStem`. */
const usableStem = (stem: string): boolean =>
  stem.length > 0 &&
  stem.length <= 64 &&
  !stem.startsWith('.') &&
  !stem.includes('..') &&
  !/[/\\]/u.test(stem) &&
  ![...stem].some(character => (character.codePointAt(0) ?? 0) < 0x20);

/** v4's `classifyConfigPath`, for a path relative to `config/`. */
export function classifyV4ConfigPath(relativePath: string): V4ConfigAddress | undefined {
  if (!relativePath.endsWith('.yaml')) return undefined;
  const parts = relativePath.slice(0, -'.yaml'.length).split('/');
  if (parts.length === 1) {
    const singleton = (Object.entries(V4_SINGLETONS) as [V4Singleton, string][]).find(
      ([, file]) => file === relativePath,
    );
    return singleton === undefined ? undefined : { kind: singleton[0] };
  }
  if (parts.length === 2) {
    const [directory, stem] = parts as [string, string];
    const named = (Object.entries(V4_NAMED) as [V4Named, string][]).find(([, folder]) => folder === directory);
    return named === undefined || !usableStem(stem) ? undefined : { kind: named[0], name: stem };
  }
  if (parts.length === 3) {
    const [directory, componentKind, stem] = parts as [string, string, string];
    const kind = V4_COMPONENT_KINDS.find(candidate => candidate === componentKind);
    return directory !== 'components' || kind === undefined || !usableStem(stem)
      ? undefined
      : { kind: 'component', componentKind: kind, name: stem };
  }
  return undefined;
}

/** v4 documents in `config/` that are not YAML config kinds: other owners split them, so they are not "ignored". */
const NOT_YAML_KINDS = new Set(['daemon.json', 'routing.json']);

export interface V4ConfigListing {
  readonly files: readonly V4ConfigFile[];
  /** Files v4 itself never read (not a config path, or a link); named for the report, never opened. */
  readonly ignored: readonly string[];
}

/**
 * Every file under `config/`, sorted. A link is never followed (v4 refused one too) and `.schema/` (generated editor
 * schemas, rebuilt by v5) is skipped whole. `config/daemon.json` and `config/routing.json` are not YAML config kinds.
 */
export async function listV4Config(home: string, overrides?: V4ConfigOverrides): Promise<V4ConfigListing> {
  const root = join(home, 'config');
  const files: V4ConfigFile[] = [];
  const ignored: string[] = [];
  const visit = async (folder: string): Promise<void> => {
    const facts = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw new V4InputError(`${relative(home, folder)}: cannot be inspected`);
    });
    if (facts === undefined) return;
    if (!facts.isDirectory()) throw new V4InputError(`${relative(home, folder)}: is not a folder`);
    for (const entry of (await readdir(folder)).sort()) {
      const path = join(folder, entry);
      const inConfig = relative(root, path);
      if (inConfig === '.schema' || NOT_YAML_KINDS.has(inConfig)) continue;
      const entryFacts = await lstat(path);
      if (entryFacts.isDirectory()) {
        await visit(path);
        continue;
      }
      const address = entryFacts.isFile() ? classifyV4ConfigPath(inConfig) : undefined;
      if (address === undefined) ignored.push(relative(home, path));
      else files.push({ address, label: relative(home, path), path });
    }
  };
  await visit(root);
  if (overrides === undefined || overrides.size === 0) return { files, ignored };
  // The overrides (in memory) replace, remove or restore a file; every other file is the disk's, listed above.
  const byLabel = new Map(files.map(file => [file.label, file]));
  let added = false;
  for (const [label, text] of overrides) {
    if (text === null) {
      byLabel.delete(label);
      continue;
    }
    const address = classifyV4ConfigPath(relative('config', label));
    if (address === undefined) continue;
    added ||= !byLabel.has(label);
    byLabel.set(label, { address, label, path: join(home, label), text });
  }
  const merged = [...byLabel.values()];
  return { files: added ? merged.sort(bySegments) : merged, ignored };
}

/** YAML 1.2's core schema with unique keys: how v4 and v5 both read a config file. */
export const YAML_OPTIONS = { version: '1.2', uniqueKeys: true, prettyErrors: false } as const;

/**
 * One v4 config file as a Document whose contents are a mapping (an empty file is an empty mapping, as v4 read it).
 * Refuses a link, a folder, an oversized file, a syntax error (located by line only) and a non-mapping body.
 */
export async function readV4Yaml(file: V4ConfigFile): Promise<Document> {
  if (file.text !== undefined) {
    if (Buffer.byteLength(file.text, 'utf8') > MAX_BYTES)
      throw new V4InputError(`${file.label}: is larger than v4's 256 KiB limit`);
    return parseV4Yaml(file.label, file.text);
  }
  const facts = await lstat(file.path).catch(() => {
    throw new V4InputError(`${file.label}: cannot be inspected`);
  });
  if (!facts.isFile()) throw new V4InputError(`${file.label}: is not a regular file`);
  if (facts.size > MAX_BYTES) throw new V4InputError(`${file.label}: is larger than v4's 256 KiB limit`);
  let text: string;
  try {
    text = await readFile(file.path, 'utf8');
  } catch {
    throw new V4InputError(`${file.label}: cannot be read`);
  }
  return parseV4Yaml(file.label, text);
}

export function parseV4Yaml(label: string, text: string): Document {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { ...YAML_OPTIONS, lineCounter });
  const [first] = document.errors;
  if (first !== undefined)
    throw new V4InputError(`${label}: is not valid YAML (line ${String(lineCounter.linePos(first.pos[0]).line)})`);
  if (document.contents === null) document.contents = document.createNode({}) as never;
  if (!isMap(document.contents)) throw new V4InputError(`${label}: is not a YAML mapping`);
  return document;
}

// ── raw secrets ──────────────────────────────────────────────────────────────────────────────────────────────────

/*
 * A copy of the v5 kernel's raw-secret rule (`packages/core/kernel/host/config/secrets.ts`, host-private, so it cannot
 * be imported through a contract). v4 refused a raw secret in a config file, so none should be here; if one is, the
 * step fails naming the file and the key, and v5 would refuse the file anyway. `${secret:NAME}` is a reference, kept.
 */
const KNOWN_SHAPES: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/u,
  /\bsk-or-[A-Za-z0-9_-]{8,}/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bgsk_[A-Za-z0-9]{20,}/u,
  /\bcsk-[A-Za-z0-9]{20,}/u,
  /\bAIza[0-9A-Za-z_-]{30,}/u,
  /\bglpat-[A-Za-z0-9_-]{16,}/u,
];
const CREDENTIAL_KEY = /(?:(?:key|token|secret|password|passwd)s?|credentials?)$/iu;
const REFERENCE = /^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)$/u;

function entropy(value: string): number {
  const characters = [...value];
  const counts = new Map<string, number>();
  for (const character of characters) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / characters.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function looksLikeRawSecret(key: string | number | undefined, value: string): boolean {
  if (KNOWN_SHAPES.some(shape => shape.test(value))) return true;
  if (typeof key !== 'string' || !CREDENTIAL_KEY.test(key)) return false;
  const trimmed = value.trim();
  if (REFERENCE.test(trimmed) || trimmed.length < 16 || /\s/u.test(trimmed)) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|[/~.])/iu.test(trimmed)) return false;
  return entropy(trimmed) >= 3.5;
}

/** The key paths of every value that looks like a raw secret (paths only: a value is never returned). */
export function rawSecretPaths(value: unknown): readonly string[] {
  const found: string[] = [];
  const visit = (node: unknown, path: readonly (string | number)[]): void => {
    if (typeof node === 'string') {
      if (
        looksLikeRawSecret(
          path.findLast(part => typeof part === 'string'),
          node,
        )
      )
        found.push(path.join('.'));
      return;
    }
    if (Array.isArray(node)) node.forEach((item, index) => visit(item, [...path, index]));
    else if (node !== null && typeof node === 'object')
      for (const [key, item] of Object.entries(node)) visit(item, [...path, key]);
  };
  visit(value, []);
  return found;
}

// ── the modeline ─────────────────────────────────────────────────────────────────────────────────────────────────

const withoutModeline = (comment: string | null | undefined): string | null => {
  if (comment === null || comment === undefined) return null;
  const kept = comment.split('\n').filter(line => !line.includes('yaml-language-server:'));
  return kept.length === 0 || kept.every(line => line.trim() === '') ? null : kept.join('\n');
};

/** Drops v4's `# yaml-language-server` modeline (it points at v4 schema ids; v5 adds its own on the next edit). */
export function dropModeline(document: Document): void {
  document.commentBefore = withoutModeline(document.commentBefore);
  const map = document.contents as YAMLMap;
  map.commentBefore = withoutModeline(map.commentBefore);
  const first = map.items[0];
  if (first !== undefined && isScalar(first.key)) first.key.commentBefore = withoutModeline(first.key.commentBefore);
}
