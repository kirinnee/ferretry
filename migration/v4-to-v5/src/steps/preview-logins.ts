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
 * - `budget`, REBUILT and MOVED: it is parsed through v5's own budget schema and a fresh object is built from the numbers
 *   of its known keys (`daily` / `weekly`, each `trigger` / `hard`), so no comment, unknown key, alias or string
 *   survives. The shell itself carries NO budget: 5.0's Usage plugin enforces spend only from `config/usage.yaml`
 *   (`budgets.<login>`), so the Settings step writes the rebuilt cap there ({@link LoginShell}'s `budget`), one owner for
 *   the fact. A budget that does not parse is not carried, and the login is HELD by name (never written capless when v4
 *   had a cap); its runtimes are held too.
 *
 * Everything else (disabled, clonedFrom*, cloudCredential, codexProvider, a half's codexProvider, unknown keys) is
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
import { looksLikeKey, pathSegment } from '../key-path.ts';
import { YAML_OPTIONS } from '../v4/config.ts';
import type { LoginKeyHold } from './login-keys.ts';

/** A whole value that is exactly one `${secret:NAME}` reference (a name only, so it is kept as it is). */
const WHOLE_REFERENCE = /^\$\{secret:([A-Z][A-Z0-9_]{0,63})\}$/u;

/** A POSIX environment variable name. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u;

/**
 * Whether a piece of text reads as a token or a key, by the migration's one conservative rule (`looksLikeKey` in
 * `key-path.ts`: a known provider prefix, or 20 or more token characters mixing a letter and a digit), widened here for
 * the underscore a base64url token uses (`key-path.ts` itself is left alone: the real converter's reports depend on it).
 * It is asked of the whole text AND of every run of 20 or more token characters inside it, so punctuation such as `:`
 * or a space cannot split a token below the limit; a known secret shape (`hasTokenShape`) counts whatever its length.
 */
export function looksLikeToken(text: string): boolean {
  if (hasTokenShape(text) || looksLikeKey(text) || looksLikeKey(text.replaceAll('_', '-'))) return true;
  return (text.match(TOKEN_RUN) ?? []).some(run => /[A-Za-z]/u.test(run) && /\d/u.test(run));
}

/** A run of 20 or more characters of the full token alphabet (base64url, base64, dots and tildes included). */
const TOKEN_RUN = /[A-Za-z0-9_.~+=-]{20,}/gu;

/** The lead's rule for a URL path, kept: 20 or more letters or digits in a row read as a token there, mixed or not. */
const ALNUM_RUN = /[A-Za-z0-9]{20,}/u;

/** A dot segment, however it is written. */
const DOT_SEGMENT = new Set(['.', '..']);

/**
 * THE ONE PLAIN-VALUE EXCEPTION (britnee's call, narrowed by the lead): an address a GLM-style login points at its
 * provider with (`ANTHROPIC_BASE_URL`) may stay plain, so the shell still names its provider. It is kept only when ALL of:
 * the variable name ends in `_URL` or `_BASE_URL`; the value is `https://` with no userinfo, no query and no fragment;
 * the real converter's rule (`storedEnvironmentIssue`) and the token rule ({@link looksLikeToken}) find no secret in it;
 * and it is KEPT AS VALIDATED: the stored bytes are exactly the URL's own serialization (a path with a dot segment,
 * `..` or `%2e%2e` in any case, is refused, because normalising it would discard a segment that then travels in the raw
 * value), and every raw path segment, and its decoded form, is no token (a webhook address carries its key in the path).
 * Anything else becomes a `${secret:NAME}` reference like any other literal.
 */
export function isPlainProviderUrl(variable: string, value: string): boolean {
  if (!/_(?:BASE_)?URL$/u.test(variable)) return false;
  if (!value.startsWith('https://') || /[?#@\s\\]/u.test(value)) return false;
  // The authority (host and port; userinfo is refused above) and the raw path, as written, split at the first slash.
  const rest = value.slice('https://'.length);
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const rawPath = slash < 0 ? '' : rest.slice(slash);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
    return false;
  if (hasTokenShape(value) || storedEnvironmentIssue(variable, value) !== undefined) return false;
  // The bytes kept are the bytes validated: the host as the URL serialises it (an international name is written in
  // punycode there, so a non-ASCII one is compared by its path alone) and the path exactly as the URL serialises it.
  if (/^[\u0020-\u007e]*$/u.test(authority) && authority.toLowerCase() !== url.host) return false;
  if ((rawPath === '' ? '/' : rawPath) !== url.pathname) return false;
  if (url.hostname.split('.').some(looksLikeToken)) return false;
  return !rawPath.split('/').some(segment => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return (
      DOT_SEGMENT.has(segment) ||
      DOT_SEGMENT.has(decoded) ||
      ALNUM_RUN.test(segment) ||
      ALNUM_RUN.test(decoded) ||
      looksLikeToken(segment) ||
      looksLikeToken(decoded)
    );
  });
}

/** What the shell kept of one login file, as field NAMES (never values). */
export type LoginShell =
  | {
      readonly kind: 'carried';
      /** The shell to serialise as a NEW document: built from the allowlist, nothing copied from the v4 one. */
      readonly document: Document;
      /** The spend cap, rebuilt from numbers, for `config/usage.yaml` `budgets.<login>` (the shell holds none); absent: v4 had none. */
      readonly budget?: Budget;
      readonly removed: readonly string[];
      readonly storeMoved: boolean;
      /** The variables whose literal value was replaced by a reference (names only). */
      readonly replaced: readonly string[];
    }
  /** Not carried: a Codex login while Codex is held, one whose harness is not named, one with no way to sign in, or one whose budget cannot be rebuilt. */
  | { readonly kind: 'held'; readonly harness: 'codex' | 'unknown' | 'no-sign-in' | 'budget' };

/** v5's own budget schema (the login file's `budget` field, which Usage reads from `usage.yaml`), so a cap is judged by the rule v5 enforces. */
const BudgetFieldSchema = LoginFileSchema.shape.budget.unwrap();

/** A rebuilt cap: fresh objects holding numbers only. */
export type Budget = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** A period's numbers as a fresh object (known keys, finite numbers only), or `undefined` when it has none. */
const periodOf = (period: { readonly trigger?: number | undefined; readonly hard?: number | undefined } | undefined) =>
  period === undefined
    ? undefined
    : {
        ...(period.trigger === undefined ? {} : { trigger: Number(period.trigger) }),
        ...(period.hard === undefined ? {} : { hard: Number(period.hard) }),
      };

/**
 * A login's `budget` rebuilt into a FRESH object from the numbers of its known keys, after v5's own schema accepted it,
 * or `'invalid'` when it does not parse (the login is then held). `undefined` (no `budget` key) is no budget.
 */
export function rebuildBudget(value: unknown, present: boolean): Budget | 'invalid' | undefined {
  if (!present) return undefined;
  const parsed = BudgetFieldSchema.safeParse(value);
  if (!parsed.success) return 'invalid';
  const daily = periodOf(parsed.data.daily);
  const weekly = periodOf(parsed.data.weekly);
  return { ...(daily === undefined ? {} : { daily }), ...(weekly === undefined ? {} : { weekly }) };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A `label` / `preset` that is a plain string and no token ({@link looksLikeToken}); a suspicious one is omitted, never said. */
const plainText = (value: unknown, max: number, pattern?: RegExp): string | undefined =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !looksLikeToken(value) &&
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
  const budget = rebuildBudget(data.budget, Object.hasOwn(data, 'budget'));
  if (budget === 'invalid') return { kind: 'held', harness: 'budget' };
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

  // The cap is carried to usage.yaml, not into the shell: the field is accounted for here, so it is not "left behind".
  if (budget !== undefined) kept.add('budget');
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
  return {
    kind: 'carried',
    document: new Document(shell, YAML_OPTIONS),
    ...(budget === undefined ? {} : { budget }),
    removed,
    storeMoved,
    replaced,
  };
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
