/**
 * The login's own environment, pinned into a Claude runtime's `--settings` file (`fixed.json`).
 *
 * WHY. Claude Code ranks a settings file's `env` above the process environment, and a folder's
 * `.claude/settings.local.json` above nothing a wrapper can export. So a repo that blanks
 * `ANTHROPIC_BASE_URL` silently turned a runtime on another provider into a signed-out one. A
 * `--settings` file ranks above both the project and the local file, per variable, so the variables a
 * login names are written there too (docs/launch-settings.md).
 *
 * THE SECRET RULE. Nothing a secret store or an environment reference resolves is ever written to that
 * file. The daemon copies `fixed.json` INLINE into argv for a fast or compact start, so the file's text
 * reaches `ps` and the session document. A variable that names `${secret:NAME}` (or `$OTHER`, whose
 * value comes from the host's environment or the secrets file at exec) stays process-environment only,
 * resolved at launch as it always was. A LITERAL in the login's YAML is already plain text in
 * configuration and is pinned. The rule is enforced twice: {@link pinnableLoginEnvironment} filters, and
 * {@link secretBackedOverlayKeys} lets the write step refuse (docs/secrets.md).
 *
 * Pure.
 */
import { secretReferencesIn } from '@ferretry/protocol';
import type { SettingsObject } from '../settings.ts';
import { envReferenceName } from '../wrappers.ts';

/** Whether a value is a LITERAL: it names no secret and no other environment variable. */
const isLiteral = (value: string): boolean =>
  secretReferencesIn(value).length === 0 && envReferenceName(value) === undefined;

/** The variables of a launch environment that are safe to write to a file shown in `ps`: the literal ones. */
export function pinnableLoginEnvironment(env: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => isLiteral(value)));
}

/** `base` with `pins` as its `env`, or `base` itself when there is nothing to pin. */
export function overlayWithPins(
  base: SettingsObject | undefined,
  pins: Readonly<Record<string, string>>,
): SettingsObject | undefined {
  if (Object.keys(pins).length === 0) return base;
  const own = base?.env;
  const existing = typeof own === 'object' && own !== null && !Array.isArray(own) ? own : {};
  return { ...(base ?? {}), env: { ...existing, ...pins } };
}

/**
 * The `env` keys of an overlay whose value is not a literal, plus `(a setting)` when a secret reference sits
 * anywhere else in it. Empty means the overlay is safe to write. Names only, never a value.
 */
export function secretBackedOverlayKeys(overlay: SettingsObject): readonly string[] {
  const env = overlay.env;
  const keys =
    typeof env === 'object' && env !== null && !Array.isArray(env)
      ? Object.entries(env).flatMap(([key, value]) => (typeof value === 'string' && !isLiteral(value) ? [key] : []))
      : [];
  return keys.length === 0 && secretReferencesIn(JSON.stringify(overlay)).length > 0 ? ['(a setting)'] : keys;
}
