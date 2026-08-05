import { referencedEnvNames, sanitizeHarnessEnv } from '../lib/harness-env.ts';
import type { FleetLoginOutcome, FleetLoginPort } from '../lib/login.ts';
import type { FleetManifestAccount } from '../lib/manifest.ts';

export interface FleetLoginProcess {
  readonly exited: Promise<number>;
}

export type FleetLoginSpawn = (
  command: readonly string[],
  options: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly cwd?: string;
  },
) => FleetLoginProcess;

export type FleetLoginRequirement = (account: FleetManifestAccount) => boolean;

/** Reading a wrapper off disk, so the port can learn which variables it depends on. */
export type FleetWrapperSource = (path: string) => Promise<string | undefined>;

/**
 * Runs one account's login by launching the wrapper the manifest publishes for it.
 *
 * The environment is **sanitized first**. `fy fleet login` is nearly always run from inside an agent
 * session, and that session exports its own provider credentials; passing them through meant the
 * login for account B could authenticate against account A's key. A wrapper that deliberately reads
 * a secret from the environment still gets it, because the names it references are read back out of
 * the wrapper itself and preserved.
 *
 * An unreadable wrapper preserves nothing rather than everything: a wrapper this port cannot read is
 * a wrapper whose intentions it does not know, and assuming the permissive reading is how the
 * contamination got in. The login then either succeeds on the account's own stored credential or
 * fails saying so — both better than silently using the caller's.
 */
export class ProcessFleetLoginPort implements FleetLoginPort {
  constructor(
    private readonly spawn: FleetLoginSpawn,
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly requiresLogin: FleetLoginRequirement,
    private readonly readWrapper: FleetWrapperSource,
    private readonly cwd?: string,
  ) {}

  async login(account: FleetManifestAccount): Promise<FleetLoginOutcome> {
    if (!this.requiresLogin(account)) {
      return { status: 'not-required' };
    }

    const script = await this.readWrapper(account.wrapper);
    const environment = sanitizeHarnessEnv(this.environment, script === undefined ? [] : referencedEnvNames(script));

    const command = account.kind === 'claude' ? [account.wrapper, '/login'] : [account.wrapper, 'login'];
    const process = this.spawn(command, {
      environment,
      ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
    });
    const code = await process.exited;
    return code === 0
      ? { status: 'logged-in' }
      : { status: 'failed', message: `login process exited with code ${code}` };
  }
}

export const spawnFleetLoginProcess: FleetLoginSpawn = (command, options) =>
  Bun.spawn({
    cmd: [...command],
    cwd: options.cwd,
    env: options.environment,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

/** Reads a generated wrapper. A wrapper that is missing or unreadable yields nothing. */
export const readFleetWrapperScript: FleetWrapperSource = async path => {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : undefined;
};
