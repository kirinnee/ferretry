import {
  MIN_SECRET_VALUE_LENGTH,
  SECRET_USE_DEFAULT_TIMEOUT_MS,
  SecretNameSchema,
  type SecretUseResult,
} from '@ferretry/protocol';
import type { ISecretGateway, ISecretOutput, ISecretValueSource } from './ports.ts';
import { renderSecretList } from './render.ts';

/** What `fy secret use` accepts beyond the command itself. */
export interface SecretUseOptions {
  /** Secrets to put in the child's environment, by name. */
  readonly with?: readonly string[];
  readonly cwd?: string;
  readonly timeout?: string;
  readonly json?: boolean;
}

export interface SecretListOptions {
  readonly json?: boolean;
}

/** The exit code a use reports when the child never ran or was killed. Distinct from any status the
 *  program could have chosen, so a caller can tell "it failed" from "ferretry stopped it". */
export const SECRET_USE_UNFINISHED_EXIT = 125;

function secretName(value: string): string {
  const parsed = SecretNameSchema.safeParse(value.trim());
  if (!parsed.success)
    throw new Error(`"${value}" is not a usable secret name — use uppercase letters, digits and underscores`);
  return parsed.data;
}

function milliseconds(value: string | undefined): number {
  if (value === undefined) return SECRET_USE_DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('--timeout must be a positive whole millisecond');
  return parsed;
}

/**
 * Drives `fy secret …`.
 *
 * THE VERB THAT MATTERS IS `use`. A person or an agent names a secret; ferretry runs the command
 * with the value in the CHILD's environment and relays the child's output back with every known
 * value masked. The caller's own process never holds the credential, so nothing it writes — a
 * transcript, a log, a screen a person is watching — can contain one.
 *
 * THERE IS NO `get`, and there is no flag that produces one. If you want one for debugging, the
 * thing to do is `fy secret use -- your-program`, not to add a read.
 *
 * BE HONEST ABOUT THE LIMIT. Masking finds the literal value. A command deliberately written to
 * transform it first — `sh -c 'echo $KEY | base64'` — defeats that, and nothing here pretends
 * otherwise. This stops accidents and casual reading; it is not a defence against an agent that is
 * trying to exfiltrate a credential it has been allowed to use.
 */
export class SecretController {
  constructor(
    private readonly gateway: ISecretGateway,
    private readonly out: ISecretOutput,
    private readonly values: ISecretValueSource,
    /**
     * Where a use runs when the caller named no `--cwd`: the directory the CLI was invoked in.
     *
     * Injected because `src/lib` may not reach the runtime for it, and OPTIONAL because a caller
     * that supplied neither is refused rather than run somewhere it did not choose — the daemon's
     * own state home is not a defensible guess.
     */
    private readonly defaultCwd: string | undefined = undefined,
  ) {}

  async list(options: SecretListOptions): Promise<void> {
    const list = await this.gateway.list();
    this.out.success(options.json === true ? JSON.stringify(list, null, 2) : renderSecretList(list));
  }

  /**
   * Stores a value read from stdin.
   *
   * THE VALUE IS NEVER AN ARGUMENT. `fy secret set TOKEN sk-live-…` would put the credential in the
   * shell history of whoever typed it and in `/proc/<pid>/cmdline` for every account on the machine,
   * which is precisely the disclosure this store exists to stop — so that spelling does not exist.
   */
  async set(name: string): Promise<void> {
    const parsed = secretName(name);
    const value = await this.values.read();
    if (value.length < MIN_SECRET_VALUE_LENGTH)
      throw new Error(
        `a secret must be at least ${MIN_SECRET_VALUE_LENGTH} characters — shorter values cannot be masked out of output safely`,
      );
    const summary = await this.gateway.put(parsed, value);
    // The name and the instant, never an echo of what was just stored.
    this.out.success(`${summary.name} stored (${summary.updatedAt})`);
  }

  async remove(name: string): Promise<void> {
    const parsed = secretName(name);
    await this.gateway.remove(parsed);
    this.out.success(`${parsed} removed`);
  }

  /**
   * Runs a command with secrets available to it, and relays what it wrote.
   *
   * The child's streams go through verbatim so this is a drop-in for the command it wraps, and the
   * child's exit code becomes ours so a script can branch on it.
   */
  async use(command: readonly string[], options: SecretUseOptions): Promise<void> {
    if (command.length === 0) throw new Error('nothing to run — put the command after `--`');
    const cwd = (options.cwd ?? this.defaultCwd ?? '').trim();
    if (cwd === '') throw new Error('no working directory — pass --cwd <absolute path>');
    const result = await this.gateway.use({
      command: [...command],
      cwd,
      secrets: (options.with ?? []).map(secretName),
      timeoutMs: milliseconds(options.timeout),
    });
    if (options.json === true) {
      this.out.success(JSON.stringify(result, null, 2));
      return;
    }
    this.report(result);
  }

  private report(result: SecretUseResult): void {
    if (result.stdout !== '') this.out.raw('stdout', result.stdout);
    if (result.stderr !== '') this.out.raw('stderr', result.stderr);
    if (result.truncated) this.out.error('(output was truncated by ferretry)');
    if (result.outcome === 'timeout') {
      this.out.error('the command did not finish in time and was stopped');
      this.out.setExitCode(SECRET_USE_UNFINISHED_EXIT);
      return;
    }
    if (result.outcome === 'spawn_failed') {
      this.out.error('the command could not be started');
      this.out.setExitCode(SECRET_USE_UNFINISHED_EXIT);
      return;
    }
    this.out.setExitCode(result.exitCode ?? SECRET_USE_UNFINISHED_EXIT);
  }
}
