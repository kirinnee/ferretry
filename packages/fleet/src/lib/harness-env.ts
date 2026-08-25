/**
 * The environment a fleet account's wrapper should be launched with.
 *
 * Every command in this product runs inside somebody's agent session — that is the whole point of
 * the fleet — and an agent session exports its own provider credentials. Handing that environment
 * straight to a wrapper for a *different* account is how one account's key ends up authenticating
 * another account's login. The wrapper exports its own home, so the home was never wrong; a bare
 * `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` the wrapper does not override is.
 *
 * So the rule is: strip the variables that carry provider identity or session state, and keep
 * everything else. The account's own wrapper re-exports whatever it actually wants.
 *
 * **Stripping is not unconditional.** A generated wrapper may deliberately source a credential from
 * the surrounding environment — `env: { OPENAI_API_KEY: "$OPENAI_API_KEY" }` is a supported and
 * documented shape (see `wrappers.ts`). A variable a wrapper *references* is therefore preserved:
 * removing it would break the account the caller is trying to fix. The caller supplies that list,
 * which is why this function takes it rather than reading a wrapper off disk — reading a file is IO
 * and this module has none.
 *
 * Ported from the source fleet tool's harness probe, where the same rule exists because the same
 * contamination bit its health probe first.
 */

/**
 * Variables that name a provider, a credential, or a live session. Removing one can only make a
 * wrapper fall back to its own configuration; keeping one can make it use somebody else's account.
 */
export const INHERITED_HARNESS_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SIMPLE',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
];

/**
 * Per-model default overrides (`ANTHROPIC_DEFAULT_SONNET_MODEL` and friends). Matched by shape
 * because the set of model slots changes with the harness, and a stale literal list would silently
 * start letting one through.
 */
const MODEL_DEFAULT_PATTERN = /^ANTHROPIC_DEFAULT_.*_MODEL$/;

const isInherited = (name: string): boolean => INHERITED_HARNESS_ENV.includes(name) || MODEL_DEFAULT_PATTERN.test(name);

/**
 * `environment` with the inherited harness state removed, except for the names in `preserve`.
 *
 * Pure: the input is not mutated and nothing is read from `process`.
 */
export function sanitizeHarnessEnv(
  environment: Readonly<Record<string, string | undefined>>,
  preserve: Iterable<string> = [],
): Record<string, string | undefined> {
  const kept = new Set(preserve);
  const sanitized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (isInherited(name) && !kept.has(name)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

/** An `export NAME="${REF}"` line as {@link renderWrapperScript} writes it, capturing `REF`. */
const EXPORTED_REFERENCE = /^\s*export\s+[A-Za-z_][A-Za-z0-9_]*="\$\{([A-Za-z_][A-Za-z0-9_]*)\}"\s*$/;

/**
 * A `: "${NAME:?…}"` requirement line, capturing `NAME`.
 *
 * A wrapper whose account takes a variable from Ferretry's secret store emits one of these and NO
 * export, because there is no value in the script to export — the daemon puts it into the launch
 * environment. So the requirement line is the only place that dependency is written down, and a
 * reader of the script that ignored it would report the account as needing nothing while the guard
 * it just skipped is the thing that will stop the launch.
 */
const REQUIRED_VARIABLE = /^\s*:\s*"\$\{([A-Za-z_][A-Za-z0-9_]*):\?/;

/**
 * The variables a rendered wrapper reads out of its surrounding environment, in first-seen order.
 *
 * Two rendering rules put a variable here, and both exist so that a credential stays out of a
 * generated file: a configured value of exactly `$NAME` is emitted as `"${NAME}"` and resolved at run
 * time, and a value naming `${secret:…}` is emitted as a requirement the daemon satisfies at launch.
 * Those are precisely the names {@link sanitizeHarnessEnv} must be told to preserve.
 *
 * A literal export is ignored: it needs nothing from the caller. Parsing the script rather than
 * re-deriving the list from configuration is deliberate — the script on disk is what will actually
 * run, so a wrapper written by an older version still reports honestly.
 */
export function referencedEnvNames(script: string): readonly string[] {
  const names: string[] = [];
  for (const line of script.split('\n')) {
    const name = EXPORTED_REFERENCE.exec(line)?.[1] ?? REQUIRED_VARIABLE.exec(line)?.[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}
