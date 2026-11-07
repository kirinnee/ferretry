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
  type SecretUseCommand,
  type SecretUseResult,
} from '../../../contract/index.ts';
import { isAbsolute } from 'node:path';
import type { ChildEnvironments } from './child-environments.ts';
import { earnedRecipes, resolveChildEnvironment } from './policy.ts';
import type { SecretChildRunner } from './types.ts';
import { MaskSourceUnavailableError } from './mask-source.ts';
import { namedMasks, NO_REDACTION, type Scrub, type TextRedactor } from './redaction.ts';
import type { SecretVault } from './vault.ts';

/** Why a use was refused before anything ran. */
import type { SecretUseRefusal } from '../../../contract/index.ts';

export type { SecretUseRefusal };

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
 * Every string that leaves here has been through `redactOutput`, INCLUDING the case where the
 * command's whole purpose was to print the value. That is the attack the integration tier tests by
 * name, because it is the one a person will actually try.
 */
export class SecretUseService {
  constructor(
    private readonly vault: SecretVault,
    private readonly runner: SecretChildRunner,
    /** Mints the opaque handle the child's environment travels in (lead decision 9). */
    private readonly environments: ChildEnvironments,
    private readonly recipes: SecretRecipes = NO_RECIPES,
    private readonly masks?: TextRedactor,
  ) {}

  /** Opens the masks for one run; an unavailable declared source is a typed refusal, not a raw failure. */
  private async openMasks<T>(work: (scrub: Scrub) => Promise<T>): Promise<T> {
    try {
      return await (this.masks ?? NO_REDACTION).scoped(work);
    } catch (error) {
      if (error instanceof MaskSourceUnavailableError)
        throw new SecretUseError('masks_unavailable', 'the values to mask could not be opened, so nothing was run');
      throw error;
    }
  }

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
    // Keep the injected snapshot even if the vault rotates during the child. It joins current,
    // contributed and typed values BEFORE any of them can rewrite the original output.
    const injected = namedMasks(values);
    // The masks open BEFORE anything spawns, and this one snapshot masks the output afterwards. A declared mask
    // provider that cannot open refuses here (S19) — after a spawn the command's side effects would be done and its
    // output lost, and every retry would run it again.
    const { outcome, masked } = await this.openMasks(async scrub => {
      const outcome = await this.runner.run({
        command: request.command,
        cwd: request.cwd,
        env: this.environments.mint(environment),
        ...(environment.PATH === undefined ? {} : { path: environment.PATH }),
        timeoutMs: request.timeoutMs,
        maxOutputBytes: MAX_SECRET_USE_OUTPUT_BYTES,
      });
      // A value the vault rotated DURING the child is not in the snapshot taken before it, so the vault's own current
      // values join the injected ones; the contributed and typed values come from the snapshot, never a second open.
      // That read is best-effort: the child has already run, so a vault that fails now must not throw away its output
      // (a retry would run it again). The injected snapshot and the open lease still hold every pre-run value.
      const current = await this.vault.values().then(
        rotated => namedMasks(rotated),
        () => [],
      );
      const during = [...injected, ...current];
      return {
        outcome,
        masked: {
          stdout: scrub.text(outcome.stdout, outcome.truncated, during),
          stderr: scrub.text(outcome.stderr, outcome.truncated, during),
        },
      };
    });
    return {
      outcome: outcome.outcome,
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      stdout: masked.stdout,
      stderr: masked.stderr,
      truncated: outcome.truncated,
      used: named,
    };
  }
}
