/**
 * What a shell item resolves to and how it is built, as pure functions (§3.2, §4.9). A shell is a flake reference or a
 * package list; either is pinned at install: a flake by its locked revision and `narHash`, a package list by the
 * nixpkgs revision and `narHash` it builds against. The cache is keyed by what the build depends on, so the same
 * pins always find the same entry.
 */
import { createHash } from 'node:crypto';
import { err, ok, type Instant, type Result } from '@ferretry/std';
import type { NarHash, PinnedNixpkgs, ShellItem, ShellLock } from '../../contract/index.ts';

const REV = /(?:^|[/@?&=])[0-9a-f]{40}(?:$|[/?&#])/u;

/** The flake part of `github:me/shells/<rev>#web` and its attribute (`web`), split at the first `#`. */
export function splitFlakeRef(ref: string): { readonly base: string; readonly attr: string | undefined } {
  const at = ref.indexOf('#');
  return at < 0 ? { base: ref, attr: undefined } : { base: ref.slice(0, at), attr: ref.slice(at + 1) };
}

/** Whether the reference already names a revision (a 40-hex path segment or `rev=`), so it can never move. */
export function isLockedFlakeRef(ref: string): boolean {
  const { base } = splitFlakeRef(ref);
  return REV.test(base) || /[?&]rev=[0-9a-f]{40}(?:&|$)/u.test(base);
}

/** What `nix flake metadata --json` said about a flake. */
export interface FlakeFacts {
  /** The locked URL (`github:me/shells/<rev>?narHash=…`). */
  readonly url: string;
  readonly rev: string;
  readonly narHash: NarHash;
}

export function parseFlakeMetadata(text: string): Result<FlakeFacts, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return err('nix did not answer in JSON');
  }
  const doc = raw as { url?: unknown; locked?: { rev?: unknown; narHash?: unknown } };
  const rev = doc.locked?.rev;
  const narHash = doc.locked?.narHash;
  if (typeof doc.url !== 'string' || doc.url === '') return err('nix named no locked address for it');
  if (typeof rev !== 'string' || rev === '') return err('it has no revision, so it cannot be pinned');
  if (typeof narHash !== 'string' || !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(narHash))
    return err('nix gave no content hash for it');
  return ok({ url: doc.url, rev, narHash: narHash as NarHash });
}

/** Environment variables a shell must not carry into a ferret: they describe the build sandbox, not the tools. */
const BUILD_ONLY = new Set([
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TEMPDIR',
  'NIX_BUILD_TOP',
  'NIX_LOG_FD',
  'PWD',
  'OLDPWD',
  'SHELL',
  'TERM',
  'USER',
  'LOGNAME',
  'out',
  'outputs',
  'builder',
  'name',
  'system',
]);

/** The exported variables of `nix print-dev-env --json`, minus what only means something inside a build. */
export function parseDevEnv(text: string): Result<Readonly<Record<string, string>>, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return err('nix did not answer in JSON');
  }
  const variables = (raw as { variables?: Record<string, { type?: unknown; value?: unknown }> }).variables;
  if (variables === undefined || typeof variables !== 'object') return err('nix described no environment');
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(variables)) {
    if (entry?.type !== 'exported' || typeof entry.value !== 'string') continue;
    if (BUILD_ONLY.has(name) || name.startsWith('NIX_BUILD_')) continue;
    env[name] = entry.value;
  }
  if (env.PATH === undefined) return err('the shell sets no PATH, so it holds no tools');
  return ok(env);
}

// ─── resolving ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The item to write to `config/shells/<name>.yaml` once resolved: pins filled in, a floating source left floating. */
export function pinnedItem(
  item: ShellItem,
  facts: FlakeFacts | undefined,
  nixpkgs: PinnedNixpkgs | undefined,
): ShellItem {
  if (item.flake !== undefined) {
    if (item.floating || facts === undefined) return item;
    const { attr } = splitFlakeRef(item.flake);
    return { ...item, flake: attr === undefined ? facts.url : `${facts.url}#${attr}` };
  }
  return { ...item, ...(nixpkgs === undefined ? {} : { nixpkgs }) };
}

export function lockOf(
  name: string,
  item: ShellItem,
  facts: FlakeFacts | undefined,
  nixpkgs: PinnedNixpkgs | undefined,
  resolvedAt: Instant,
): Result<ShellLock, string> {
  if (item.flake !== undefined) {
    if (facts === undefined) return err('the flake was not resolved');
    const { attr } = splitFlakeRef(item.flake);
    return ok({
      format: 1,
      name,
      source: {
        kind: 'flake',
        ref: attr === undefined ? facts.url : `${facts.url}#${attr}`,
        rev: facts.rev,
        narHash: facts.narHash,
      },
      resolvedAt,
      floating: item.floating,
    });
  }
  if (nixpkgs === undefined || item.packages === undefined) return err('the package list was not resolved');
  return ok({
    format: 1,
    name,
    source: { kind: 'packages', packages: [...item.packages], nixpkgs },
    resolvedAt,
    floating: item.floating,
  });
}

/** The hash a lock stands on: the flake's, or the nixpkgs a package list builds against. */
export const narHashOf = (lock: ShellLock): NarHash =>
  lock.source.kind === 'flake' ? lock.source.narHash : lock.source.nixpkgs.narHash;

// ─── building ────────────────────────────────────────────────────────────────────────────────────────────────────

const nixString = (text: string): string => `"${text.replace(/[\\"$]/gu, ch => `\\${ch}`)}"`;

/** The nix expression of a package list on its pinned nixpkgs. Package names are checked by the schema; quoted anyway. */
export function packagesExpression(nixpkgs: PinnedNixpkgs, packages: readonly string[]): string {
  const url = `github:NixOS/nixpkgs/${nixpkgs.rev}?narHash=${encodeURIComponent(nixpkgs.narHash)}`;
  const list = packages
    .map(
      attr =>
        `(pkgs.lib.attrByPath (pkgs.lib.splitString "." ${nixString(attr)}) (throw ${nixString(`no package ${attr}`)}) pkgs)`,
    )
    .join(' ');
  return `let pkgs = import (builtins.getFlake ${nixString(url)}) { system = builtins.currentSystem; }; in pkgs.mkShell { packages = [ ${list} ]; }`;
}

/** The arguments (after `nix`) that build a locked shell and print its environment. */
export function devEnvArguments(lock: ShellLock): readonly string[] {
  const head = ['--extra-experimental-features', 'nix-command flakes', 'print-dev-env', '--json'];
  return lock.source.kind === 'flake'
    ? [...head, lock.source.ref]
    : [...head, '--impure', '--expr', packagesExpression(lock.source.nixpkgs, lock.source.packages)];
}

/** What a build depends on, as an SRI hash: the same pins and attribute always find the same cache entry. */
export function buildKey(lock: ShellLock): NarHash {
  const canonical =
    lock.source.kind === 'flake'
      ? `flake\0${lock.source.ref}`
      : `packages\0${lock.source.nixpkgs.rev}\0${lock.source.nixpkgs.narHash}\0${[...lock.source.packages].toSorted().join(',')}`;
  return `sha256-${createHash('sha256').update(canonical).digest('base64')}` as NarHash;
}

/** `state/shells/cache/<this>`: the key without the characters a file name cannot hold. */
export const cacheName = (key: NarHash): string =>
  key.slice('sha256-'.length).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
