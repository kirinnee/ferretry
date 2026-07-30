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

export class ProcessFleetLoginPort implements FleetLoginPort {
  constructor(
    private readonly spawn: FleetLoginSpawn,
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly requiresLogin: FleetLoginRequirement,
    private readonly cwd?: string,
  ) {}

  async login(account: FleetManifestAccount): Promise<FleetLoginOutcome> {
    if (!this.requiresLogin(account)) {
      return { status: 'not-required' };
    }

    const command = account.kind === 'claude' ? [account.wrapper, '/login'] : [account.wrapper, 'login'];
    const process = this.spawn(command, {
      environment: this.environment,
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
