/**
 * What a harness's own environment block becomes on an imported login (r9 A8).
 *
 * The setup import finds `env` in the host's Claude settings (and Codex's `shell_environment_policy.set`). Runtimes has
 * already filed every secret-looking value in the Vault (create-only) and hands over two lists: host text (`plain`) and
 * the variables whose secret this apply filed (`minted`, by secret NAME). This decides which of those a LOGIN carries: a
 * login's environment is resolved when a ferret launches, which a `${secret:}` in a settings item is not.
 *
 * Pure, and it never holds a secret: plain text that holds any reference syntax is refused (a Vault reference comes only
 * from `minted`, which this turns into `${secret:NAME}` itself), a value that still looks like a key is refused as a second
 * guard, and a sentence names a variable, never what it holds. A name that is itself shaped like a key is not repeated.
 */
import { looksSecret } from '@ferretry/std/credential-words';
import { SecretNameSchema, secretReference } from '@ferretry/core-vault/contract';
import { RESERVED_LOGIN_ENV_NAMES } from '../../../contract/wire.ts';
import {
  GITHUB_TOKEN_NAMES,
  GITHUB_TOKEN_SENTENCE,
  MASKED_VARIABLE_NAME,
  maskedVariableName,
  type MintedVariable,
  type PlainVariable,
  type SkippedVariable,
} from '../../../contract/env-import.ts';

const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** Any spelling of a Vault reference, well formed or not, including the optional `${secret?:NAME}` form. */
const REFERENCE_SYNTAX = /\$\{\s*secret\b/iu;

/** What a name that is shaped like a key is called instead of being repeated. */
export const MASKED_NAME = MASKED_VARIABLE_NAME;

/** A name as a sentence may repeat it. */
export const shownName = maskedVariableName;

/** What the import takes from a block of variables. */
export interface LoginEnvPlan {
  /** The variables the login gets: plain text, or exactly one `${secret:NAME}` for a minted key. */
  readonly env: Readonly<Record<string, string>>;
  readonly skipped: readonly SkippedVariable[];
}

const isGithubToken = (name: string): boolean => GITHUB_TOKEN_NAMES.includes(name.toUpperCase());

/**
 * The variables a login takes.
 *
 * `ticked` names the GitHub token variables the person chose to bring in; every other variable is judged by its own name
 * and value alone.
 */
export function planLoginEnv(
  plain: readonly PlainVariable[],
  minted: readonly MintedVariable[],
  ticked: ReadonlySet<string> = new Set(),
): LoginEnvPlan {
  const env: Record<string, string> = {};
  const skipped: SkippedVariable[] = [];
  const skip = (name: string, because: string): void => {
    skipped.push({ name: shownName(name), because });
  };
  /** The checks both lists share; `true` when the name may be set. */
  const nameOk = (name: string): boolean => {
    if (!POSIX_ENV_NAME.test(name)) {
      // A name that is not a variable name is not repeated: it could hold anything.
      skipped.push({ name: '(a name that is not an environment variable name)', because: 'it cannot be set' });
      return false;
    }
    if ((RESERVED_LOGIN_ENV_NAMES as readonly string[]).includes(name)) {
      skip(name, 'Ferretry sets it for each runtime');
      return false;
    }
    if (isGithubToken(name) && !ticked.has(name)) {
      skip(name, GITHUB_TOKEN_SENTENCE);
      return false;
    }
    if (Object.hasOwn(env, name)) {
      skip(name, 'it was named twice');
      return false;
    }
    return true;
  };
  for (const { name, value } of plain) {
    if (!nameOk(name)) continue;
    if (REFERENCE_SYNTAX.test(value)) {
      skip(name, 'it holds a secret reference, and a reference may only come from a key this import filed itself');
      continue;
    }
    // Plain text is all this list may hold. Anything that still reads as a key was not moved into the Vault, so it is left
    // out rather than written where every device could read it.
    if (looksSecret(name, value)) {
      skip(name, 'it looks like a key that was not kept in the Vault, so it was left out');
      continue;
    }
    env[name] = value;
  }
  for (const { name, secretName } of minted) {
    if (!nameOk(name)) continue;
    const parsed = SecretNameSchema.safeParse(secretName);
    if (!parsed.success) {
      skip(name, 'the key filed for it has no valid secret name');
      continue;
    }
    env[name] = secretReference(parsed.data);
  }
  return { env, skipped };
}
