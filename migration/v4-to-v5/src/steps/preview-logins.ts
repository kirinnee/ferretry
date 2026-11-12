/**
 * The preview carries each v4 `config/logins/<id>.yaml` as an empty, SIGNED-OUT shell, so every runtime that names a
 * login still finds it (a runtime whose login is missing makes the whole fleet configuration unreadable, in v4 and in
 * 5.0 alike) and shows "Needs sign-in" exactly like a signed-out v4 login.
 *
 * THE SHELL IS BUILT, NEVER SCRUBBED. {@link buildShell} reads a short allowlist of fields out of the parsed v4 login and
 * builds a FRESH object from them, which the caller serialises as a NEW YAML document. Nothing of the v4 document (a
 * comment, an unknown key, a nested comment, a key or a path in a value) can reach the shell, because nothing is copied
 * from it that this list does not name:
 *
 * - `harness` and `store` (`store: host` is written as `store: ferretry`: the preview's HOME is empty by design, so a
 *   host login would find no sign-in to share), `label` and `preset` when they are plain non-secret strings;
 * - the NAMES of the variables of `env`, and of `claude.env` / `codex.env`, each with a value that is either
 *   (a) already a whole `${secret:NAME}` reference, kept; or (b) the one narrow plain-URL exception below; or (c) ANY
 *   OTHER literal (a key, a credential-file path such as GOOGLE_APPLICATION_CREDENTIALS, a flag, a number), which is NOT
 *   carried: it is written as a `${secret:NAME}` reference (the real converter's `LOGIN_<ID>_<VAR>` naming) and the value
 *   is discarded, never sealed, never staged. The owner stores the secret with `fy secret set NAME`.
 *
 * Everything else (budget, disabled, clonedFrom*, cloudCredential, codexProvider, a half's codexProvider, unknown keys) is
 * left behind, named by field. `fleet/credentials` (the sign-in itself) stays denied by the plan. This is the PREVIEW
 * only; the real converter keeps `store: host` and the whole file.
 *
 * A login that ends up with no way to sign in (a cloud-only one: `store: environment` and a `cloudCredential`, no `env`)
 * is HELD by name instead of written as an invalid file, and so are its runtimes. A Codex login is not carried while Codex
 * is held (`holdsCodex`).
 */
import { hasTokenShape, LoginFileSchema, storedEnvironmentIssue } from '@ferretry/plugin-logins/contract';
import { SecretNameSchema, secretReference } from '@ferretry/core-vault/contract';
import { Document } from 'yaml';
import { pathSegment } from '../key-path.ts';
import { YAML_OPTIONS } from '../v4/config.ts';
import type { LoginKeyHold } from './login-keys.ts';

/** A whole value that is exactly one `${secret:NAME}` reference (a name only, so it is kept as it is). */
const WHOLE_REFERENCE = /^\$\{secret:([A-Z][A-Z0-9_]{0,63})\}$/u;

/** A POSIX environment variable name. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u;

/** A run of 20 or more letters and digits in a URL path segment reads as a token. */
const TOKEN_RUN = /[A-Za-z0-9]{20,}/u;

/**
 * THE ONE PLAIN-VALUE EXCEPTION (britnee's call, narrowed by the lead): an address a GLM-style login points at its
 * provider with (`ANTHROPIC_BASE_URL`) may stay plain, so the shell still names its provider. It is kept only when ALL of:
 * the variable name ends in `_URL` or `_BASE_URL`; the value is `https://` with no userinfo, no query and no fragment;
 * the real converter's rule (`storedEnvironmentIssue`) and the token-shape rule find no secret in it; and no path segment
 * looks like a token (20 or more letters or digits in a row; a webhook address carries its key in the path). Anything else
 * becomes a `${secret:NAME}` reference like any other literal.
 */
export function isPlainProviderUrl(variable: string, value: string): boolean {
  if (!/_(?:BASE_)?URL$/u.test(variable)) return false;
  if (!value.startsWith('https://') || /[?#@\s\\]/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
    return false;
  if (hasTokenShape(value) || storedEnvironmentIssue(variable, value) !== undefined) return false;
  return !url.pathname.split('/').some(segment => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return TOKEN_RUN.test(segment) || TOKEN_RUN.test(decoded) || hasTokenShape(decoded);
  });
}

/** What the shell kept of one login file, as field NAMES (never values). */
export type LoginShell =
  | {
      readonly kind: 'carried';
      /** The shell to serialise as a NEW document: built from the allowlist, nothing copied from the v4 one. */
      readonly document: Document;
      readonly removed: readonly string[];
      readonly storeMoved: boolean;
      /** The variables whose literal value was replaced by a reference (names only). */
      readonly replaced: readonly string[];
    }
  /** Not carried: a Codex login while Codex is held, one whose harness is not named, or one with no way to sign in. */
  | { readonly kind: 'held'; readonly harness: 'codex' | 'unknown' | 'no-sign-in' };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A `label` / `preset` that is a plain string and no token. */
const plainText = (value: unknown, max: number, pattern?: RegExp): string | undefined =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !hasTokenShape(value) &&
  (pattern === undefined || pattern.test(value))
    ? value
    : undefined;

/**
 * Builds a login's shell from its parsed v4 document. Reads only the allowlisted fields' values (`toJS()` drops every
 * comment); each literal env value is looked at only to be thrown away, and its digest goes to the hold's ledger
 * ({@link LoginKeyHold.discard}) beside the NAME the shell uses. Never throws on a value; says field names only.
 */
export function buildShell(document: Document, login: string, holdCodex: boolean, hold: LoginKeyHold): LoginShell {
  let data: unknown;
  try {
    data = document.toJS({ maxAliasCount: 100 });
  } catch {
    // An alias that does not resolve or is a bomb: the library's message quotes the text it choked on, so none is kept.
    return { kind: 'held', harness: 'unknown' };
  }
  if (!isRecord(data)) return { kind: 'held', harness: 'unknown' };
  const harness = data.harness;
  const isCodex = harness === 'codex';
  if (harness !== 'claude' && harness !== 'claude-code' && !isCodex) return { kind: 'held', harness: 'unknown' };
  if (isCodex && holdCodex) return { kind: 'held', harness: 'codex' };

  const kept = new Set<string>(['harness', 'store']);
  const removed: string[] = [];
  const replaced: string[] = [];
  // v5 spells v4's `claude` as `claude-code` (the Settings step would rewrite it later; the shell is checked in v5's spelling).
  const shell: Record<string, unknown> = { harness: harness === 'claude' ? 'claude-code' : harness };

  const store = data.store === 'host' ? 'ferretry' : data.store;
  const storeMoved = data.store === 'host';
  if (store !== undefined && store !== 'ferretry' && store !== 'environment')
    return { kind: 'held', harness: 'no-sign-in' };
  if (store !== undefined) shell.store = store;
  const environment = store === 'environment';

  const label = plainText(data.label, 200);
  if (label !== undefined) {
    shell.label = label;
    kept.add('label');
  }
  // Only a login kept in the environment has a preset, variables or halves (v5 refuses them on any other store).
  const preset = environment ? plainText(data.preset, 64, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u) : undefined;
  if (preset !== undefined) {
    shell.preset = preset;
    kept.add('preset');
  }

  /** One env map as a fresh object: kept references and URLs, every other literal as a reference to a discarded value. */
  const envOf = (value: unknown, where: string): Record<string, string> | undefined => {
    if (!environment || !isRecord(value)) return undefined;
    const out: Record<string, string> = {};
    for (const [variable, literal] of Object.entries(value)) {
      const said = pathSegment(variable);
      if (!VARIABLE_NAME.test(variable) || said === '<key>') {
        removed.push(`${where}.<key>`);
        continue;
      }
      if (typeof literal === 'string' && (WHOLE_REFERENCE.test(literal) || isPlainProviderUrl(variable, literal))) {
        out[variable] = literal;
        continue;
      }
      const name = hold.claim(login, variable);
      hold.discard(
        { login, variable: where === 'env' ? said : `${where}.${said}`, name },
        typeof literal === 'string' ? literal : (JSON.stringify(literal) ?? ''),
      );
      out[variable] = secretReference(SecretNameSchema.parse(name));
      replaced.push(where === 'env' ? said : `${where}.${said}`);
    }
    return out;
  };

  const env = envOf(data.env, 'env');
  if (env !== undefined) {
    shell.env = env;
    kept.add('env');
  }
  for (const half of ['claude', 'codex'] as const) {
    if (!environment || (half === 'codex' && holdCodex)) continue;
    const value = data[half];
    if (!isRecord(value)) continue;
    const halfEnv = envOf(value.env, `${half}.env`);
    shell[half] = { env: halfEnv ?? {} };
    kept.add(half);
    for (const inner of Object.keys(value)) if (inner !== 'env') removed.push(`${half}.${pathSegment(inner)}`);
  }
  for (const key of Object.keys(data)) if (!kept.has(key)) removed.push(pathSegment(key));

  const built = LoginFileSchema.safeParse(shell);
  if (!built.success || signInIssue(shell, harness) !== undefined) return { kind: 'held', harness: 'no-sign-in' };
  return { kind: 'carried', document: new Document(shell, YAML_OPTIONS), removed, storeMoved, replaced };
}

/**
 * Why a built shell has no way to sign in, or `undefined`. The cross-field rule v5 applies to a login kept in the
 * environment (the logins plugin's `credentialIssues`, which this tool may not import; a unit test holds the two to the
 * same answer): its `env` (or a half's) must name at least one variable, and with halves the login's own half must exist.
 */
export function signInIssue(shell: Readonly<Record<string, unknown>>, harness: unknown): string | undefined {
  if (shell.store !== 'environment') return undefined;
  const envOf = (value: unknown): Readonly<Record<string, unknown>> =>
    isRecord(value) && isRecord(value.env) ? value.env : {};
  const top = isRecord(shell.env) ? shell.env : {};
  const claude = shell.claude;
  const codex = shell.codex;
  if (claude !== undefined || codex !== undefined) {
    const own = harness === 'codex' ? codex : claude;
    if (own === undefined) return 'the harness half is missing';
  }
  const variables = { ...top, ...envOf(claude), ...envOf(codex) };
  return Object.keys(variables).length === 0
    ? 'a login kept in the environment must say which variables authenticate it'
    : undefined;
}
