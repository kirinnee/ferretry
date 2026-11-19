/**
 * What a harness's own environment block becomes on an imported login (r9 A8).
 *
 * The setup import finds `env` in the host's Claude settings (and Codex's `shell_environment_policy.set`). The planner in
 * Runtimes has already turned every secret-looking value into a `${secret:NAME}` reference (the value went to the Vault,
 * create-only), so what arrives here is plain text and references. This decides which of those variables a LOGIN carries:
 * a login's environment is resolved when a ferret launches, which a `${secret:}` in a settings item is not.
 *
 * Pure, and it never holds a secret: a value that still looks like one is refused here as a second guard, and a sentence
 * names a variable, never what it holds.
 */
import { looksSecret } from '@ferretry/std/credential-words';
import { malformedSecretReference, secretReferencesIn } from '@ferretry/core-vault/contract';
import { RESERVED_LOGIN_ENV_NAMES } from '../../../contract/wire.ts';
import { GITHUB_TOKEN_NAMES, GITHUB_TOKEN_SENTENCE, type SkippedVariable } from '../../../contract/env-import.ts';

const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** What the import takes from a block of variables. */
export interface LoginEnvPlan {
  /** The variables the login gets: plain text, or text holding `${secret:NAME}` references. */
  readonly env: Readonly<Record<string, string>>;
  readonly skipped: readonly SkippedVariable[];
}

const isGithubToken = (name: string): boolean => GITHUB_TOKEN_NAMES.includes(name.toUpperCase());

/**
 * The variables of `block` a login takes.
 *
 * `ticked` names the GitHub token variables the person chose to bring in; every other variable is judged by its own name
 * and value alone.
 */
export function planLoginEnv(
  block: Readonly<Record<string, string>>,
  ticked: ReadonlySet<string> = new Set(),
): LoginEnvPlan {
  const env: Record<string, string> = {};
  const skipped: SkippedVariable[] = [];
  const skip = (name: string, because: string): void => {
    skipped.push({ name, because });
  };
  for (const [name, value] of Object.entries(block)) {
    if (!POSIX_ENV_NAME.test(name)) {
      // A name that is not a variable name is not repeated: it could hold anything.
      skipped.push({ name: '(a name that is not an environment variable name)', because: 'it cannot be set' });
      continue;
    }
    if ((RESERVED_LOGIN_ENV_NAMES as readonly string[]).includes(name)) {
      skip(name, 'Ferretry sets it for each runtime');
      continue;
    }
    if (isGithubToken(name) && !ticked.has(name)) {
      skip(name, GITHUB_TOKEN_SENTENCE);
      continue;
    }
    if (malformedSecretReference(value) !== undefined) {
      skip(name, 'it holds a malformed secret reference');
      continue;
    }
    // Plain text or a reference is all a login file may hold. Anything that still reads as a key was not moved into the
    // Vault, so it is left out rather than written where every device could read it.
    if (secretReferencesIn(value).length === 0 && looksSecret(name, value)) {
      skip(name, 'it looks like a key that was not kept in the Vault, so it was left out');
      continue;
    }
    env[name] = value;
  }
  return { env, skipped };
}
