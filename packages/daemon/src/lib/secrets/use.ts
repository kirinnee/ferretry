/**
 * USE, NEVER READ — the primitive the whole subsystem exists for.
 *
 * An agent asks this daemon to run a command with a secret available to it. The daemon resolves the
 * reference, puts the value in the environment of the CHILD it spawns, and hands back that child's
 * output with every known value masked. The agent writes the reference and nothing else, so its own
 * conversation — the transcript, the history, the screen a person is watching — contains a name and
 * never a credential.
 *
 * WHY THAT IS STRONGER THAN INJECTING INTO THE AGENT. An agent handed a secret in its own environment
 * can read it, because it needs it; "the agent cannot see it" was then simply false, and only
 * redaction kept the transcript clean. Moving the value into a child the agent never inhabits means
 * there is nothing in the agent to echo in the first place.
 *
 * THE RESIDUAL HOLE, STATED PLAINLY. The child's output is scrubbed, so `-- sh -c 'echo $KEY'`
 * returns a mask. An agent that TRANSFORMS the value first — `echo $KEY | base64`, reversed, one
 * character per line — produces text that shares no substring with the secret, and nothing here can
 * recognise it. So:
 *
 *   PROTECTS AGAINST: secrets landing in transcripts and shell history, a person reading one off a
 *   screen, a value written into a configuration file or copied with one, an agent or tool printing
 *   one incidentally.
 *
 *   DOES NOT PROTECT AGAINST: an agent that is actively trying to exfiltrate a secret it has been
 *   given permission to use.
 *
 * That is the same boundary `sudo` has, and it is a genuinely useful one — but anybody who believes
 * the stronger version will hand an untrusted agent a production credential, so it is written here,
 * in the protocol, in the CLI help and on the screen.
 */

import {
  MAX_SECRET_USE_OUTPUT_BYTES,
  type SecretName,
  secretMask,
  type SecretUseCommand,
  type SecretUseResult,
} from '@ferretry/protocol';
import { isAbsolute } from 'node:path';
import { earnedRecipes, redactSecretValues, resolveChildEnvironment } from './policy.ts';
import type { SecretChildRunner } from './types.ts';
import type { SecretVault } from './vault.ts';

/** Why a use was refused before anything ran. */
export type SecretUseRefusal = 'invalid_cwd' | 'unknown_secret';

export class SecretUseError extends Error {
  constructor(
    readonly refusal: SecretUseRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'SecretUseError';
  }
}

/** The operator's reusable env recipes, whose values may hold `${secret:NAME}` references. */
export interface SecretRecipes {
  read(): Promise<Readonly<Record<string, string>>>;
}

/** No recipes configured: every child gets exactly the secrets its own request named. */
export const NO_RECIPES: SecretRecipes = { read: async () => ({}) };

/**
 * Runs one command with secrets in its environment and returns its scrubbed output.
 *
 * Every string that leaves here has been through `redactSecretValues`, INCLUDING the case where the
 * command's whole purpose was to print the value. That is the attack the integration tier tests by
 * name, because it is the one a person will actually try.
 */
export class SecretUseService {
  constructor(
    private readonly vault: SecretVault,
    private readonly runner: SecretChildRunner,
    private readonly recipes: SecretRecipes = NO_RECIPES,
  ) {}

  async run(request: SecretUseCommand): Promise<SecretUseResult> {
    // A relative directory would run the child wherever this daemon happens to be, which is its own
    // state home. Refused rather than resolved: guessing here means running the caller's command
    // somewhere they did not name.
    if (!isAbsolute(request.cwd)) throw new SecretUseError('invalid_cwd', 'cwd must be an absolute path');
    const values = await this.vault.values();
    const named: readonly SecretName[] = request.secrets;
    const environment = resolveChildEnvironment(
      named,
      { ...earnedRecipes(await this.recipes.read(), named), ...request.env },
      values,
    );
    const outcome = await this.runner.run({
      command: request.command,
      cwd: request.cwd,
      env: environment,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: MAX_SECRET_USE_OUTPUT_BYTES,
    });
    return {
      outcome: outcome.outcome,
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      stdout: redactOutput(outcome.stdout, values, outcome.truncated),
      stderr: redactOutput(outcome.stderr, values, outcome.truncated),
      truncated: outcome.truncated,
      used: named,
    };
  }
}

/** A child's output with every known value masked, including one the output limit cut in half. */
function redactOutput(text: string, values: ReadonlyMap<SecretName, string>, cut: boolean): string {
  const redacted = redactSecretValues(text, values);
  return cut ? maskCutValue(redacted, values) : redacted;
}

/**
 * Masks the BEGINNING of a value that a cut left at the very end of the text.
 *
 * A WHOLE-VALUE MATCH CANNOT SEE IT. Output is capped before it reaches redaction — and a timeout
 * kills the child mid-write — so a value straddling the cut arrives as a prefix that is not the value
 * and passes straight through, handing the reader that many characters of the credential. The cost of
 * the fix is that a truncated output whose last characters merely LOOK like the start of a value loses
 * them to a mask; on output that was already cut short that is the right side to err on.
 *
 * A byte cut can split a character, which the decoder writes as U+FFFD, so trailing replacement
 * characters are set aside before matching — otherwise one would shield the prefix in front of it.
 */
function maskCutValue(text: string, values: ReadonlyMap<SecretName, string>): string {
  const body = text.replace(/\uFFFD+$/u, '');
  let longest: { readonly name: SecretName; readonly length: number } | undefined;
  for (const [name, value] of values)
    for (let length = Math.min(value.length - 1, body.length); length > (longest?.length ?? 0); length--)
      if (body.endsWith(value.slice(0, length))) {
        longest = { name, length };
        break;
      }
  return longest === undefined ? text : body.slice(0, body.length - longest.length) + secretMask(longest.name);
}
