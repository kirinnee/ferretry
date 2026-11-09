/**
 * The private-files rule (§7.7, §9.3): which files under a plugin's `state/<id>/` a ferret must never reach, declared by
 * the plugin that owns them and composed by the kernel into the one list its fence reads. Pure and total: the manifest
 * check (`definePlugin`), the workspace check (`scripts/validate/private-files.ts`) and the host's fence all read THIS
 * module, so the three can never disagree about what a name means.
 *
 * Fail closed: a state file whose name says it holds a key, a secret, a token, a passkey, a credential or an OAuth
 * record is refused unless the plugin says so either way — `private` (the fence pins it by identity) or `public` with
 * a written reason. A plugin cannot forget one; it can only decide one.
 */
import type { Manifest } from './types.ts';

/** The words a file name must not say without a declaration, matched as case-insensitive substrings. */
export const SECRET_NAME_WORDS: readonly string[] = ['key', 'secret', 'token', 'passkey', 'credential', 'oauth'];

/** Whether one path segment says it holds something secret (`vault.key`, `Tokens.json`, `OAUTH-secrets`). */
export function namesASecret(segment: string): boolean {
  const lower = segment.toLowerCase();
  return SECRET_NAME_WORDS.some(word => lower.includes(word));
}

/** The shortest reason a `public` declaration may carry: a sentence a reviewer can disagree with, not a word. */
export const MIN_PUBLIC_REASON = 12;

const segmentsOf = (path: string): string[] => path.split('/');

/** A declared path is relative to the plugin's state folder: plain segments, at most one `*`, never `.` or `..`. */
function pathProblem(path: string): string | undefined {
  const segments = segmentsOf(path);
  if (path === '' || path.startsWith('/') || path.includes('\0'))
    return `"${path}" is not a path inside the plugin's state folder`;
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..'))
    return `"${path}" has an empty, "." or ".." segment`;
  if (path.split('*').length - 1 > 1) return `"${path}" has more than one "*"`;
  return undefined;
}

/**
 * Whether `declared` covers `path`: the same path, or a folder `path` sits in (`credentials` covers `credentials/*`).
 * A declared pattern covers the same pattern only, never a different one that merely looks alike.
 */
export function covers(declared: string, path: string): boolean {
  return path === declared || path.startsWith(`${declared}/`);
}

/**
 * Files a plugin keeps that no `defineState` names, so `privacy.private` has nothing to match them to: the kernel's own
 * `identity.json` (the daemon's signing key, written by the host's identity module, not the state port). Judged by the
 * same rule as a declared file, and an entry for one is not a typo.
 */
export const UNDECLARED_FILES: ReadonlyMap<string, readonly string[]> = new Map([['kernel', ['identity.json']]]);

/** The state paths a manifest declares, plain strings (the `*` kept). */
export const stateFilePaths = (manifest: Pick<Manifest, 'data'>): readonly string[] =>
  (manifest.data?.state ?? []).map(def => def.path);

/** What one manifest's privacy declaration gets wrong. Empty when it is sound. */
export function privacyProblems(
  manifest: Pick<Manifest, 'id' | 'data' | 'privacy'>,
  /** Files this plugin keeps that no `defineState` names (the kernel's own `identity.json`), judged the same way. */
  extra: readonly string[] = [],
): readonly string[] {
  const problems: string[] = [];
  const privatePaths = manifest.privacy?.private ?? [];
  const publicFiles = manifest.privacy?.public ?? [];
  for (const path of privatePaths) {
    const bad = pathProblem(path);
    if (bad !== undefined) problems.push(`${manifest.id} (privacy): private file ${bad}`);
    else if (segmentsOf(path)[0]?.includes('*') === true)
      problems.push(`${manifest.id} (privacy): private file "${path}" must start with a plain folder or file name`);
  }
  for (const entry of publicFiles) {
    const bad = pathProblem(entry.path);
    if (bad !== undefined) problems.push(`${manifest.id} (privacy): public file ${bad}`);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_PUBLIC_REASON)
      problems.push(
        `${manifest.id} (privacy): public file "${entry.path}" needs a written reason (at least ${MIN_PUBLIC_REASON} characters)`,
      );
    if (privatePaths.some(declared => covers(declared, entry.path) || covers(entry.path, declared)))
      problems.push(`${manifest.id} (privacy): "${entry.path}" is declared both private and public`);
  }
  for (const path of [...stateFilePaths(manifest), ...extra]) {
    if (!segmentsOf(path).some(namesASecret)) continue;
    const isPrivate = privatePaths.some(declared => covers(declared, path));
    const isPublic = publicFiles.some(entry => entry.path === path || covers(entry.path, path));
    if (!isPrivate && !isPublic)
      problems.push(
        `${manifest.id} (privacy): state file "${path}" is named like a secret (key, secret, token, passkey, credential or oauth) ` +
          'but is declared neither in privacy.private nor in privacy.public with a reason',
      );
  }
  return problems;
}

/**
 * Every problem in every manifest a host was handed, as one sentence each. `definePlugin` refuses a bad manifest where it
 * is written; a host asks again at load, because a manifest can reach it without that call (a literal, a copy). Empty
 * when the whole set is sound.
 */
export const privacyRefusals = (manifests: readonly Pick<Manifest, 'id' | 'data' | 'privacy'>[]): readonly string[] =>
  manifests.flatMap(manifest => privacyProblems(manifest, UNDECLARED_FILES.get(manifest.id) ?? []));

/**
 * The home-relative places the fence pins for one plugin: `state/<id>/<path>`, a pattern cut at its first `*` segment so
 * the FOLDER is what is pinned (`credentials/*` pins `state/<id>/credentials`; every name below it is held by it).
 */
export function privatePlaces(manifest: Pick<Manifest, 'id' | 'privacy'>): readonly string[] {
  return (manifest.privacy?.private ?? []).flatMap(path => {
    if (pathProblem(path) !== undefined) return [];
    const kept: string[] = [];
    for (const segment of segmentsOf(path)) {
      if (segment.includes('*')) break;
      kept.push(segment);
    }
    return kept.length === 0 ? [] : [`state/${manifest.id}/${kept.join('/')}`];
  });
}

/** The composed list: every loaded plugin's private places, once each, in a fixed order. */
export function composePrivateFiles(manifests: readonly Pick<Manifest, 'id' | 'privacy'>[]): readonly string[] {
  return [...new Set(manifests.flatMap(privatePlaces))].sort();
}
