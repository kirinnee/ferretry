import { referencedEnvNames, sanitizeHarnessEnv } from '../lib/harness-env.ts';
import type { FleetLoginOutcome, FleetLoginPort, FleetLoginTarget } from '../lib/login.ts';
import type { HarnessKind } from '../lib/manifest.ts';

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

/** Reading a wrapper off disk, so the port can learn which variables it depends on. */
export type FleetWrapperSource = (path: string) => Promise<string | undefined>;

/** Where a bare harness CLI lives on `PATH`, when it is installed at all. */
export type FleetBinaryLookup = (binary: string) => string | undefined;

/** The harness CLI to fall back to, and the argument that makes it log in. */
const HARNESS_LOGIN: Readonly<Record<HarnessKind, { readonly binary: string; readonly argument: string }>> = {
  claude: { binary: 'claude', argument: '/login' },
  codex: { binary: 'codex', argument: 'login' },
};

export interface ProcessFleetLoginDeps {
  readonly spawn: FleetLoginSpawn;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly readWrapper: FleetWrapperSource;
  readonly which: FleetBinaryLookup;
  readonly cwd?: string;
}

/**
 * Runs one account's interactive login by launching the wrapper the manifest publishes for it.
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
 *
 * **A host where the wrapper does not exist yet still works.** Provisioning may never have run, and a
 * fresh machine is exactly when somebody needs to log in; the tool this replaces carried the same
 * fallback for the same reason. A missing wrapper falls back to the harness CLI on `PATH`, and a host
 * with neither says which of the two to install rather than reporting an exit code. The fallback gets
 * no preserved variables, because a bare CLI references none — the account's own home is not exported
 * either, so this path logs in whatever home the CLI defaults to and only makes sense on a host that
 * has not been provisioned at all.
 */
export class ProcessFleetLoginPort implements FleetLoginPort {
  constructor(private readonly deps: ProcessFleetLoginDeps) {}

  async login(target: FleetLoginTarget): Promise<FleetLoginOutcome> {
    const spec = HARNESS_LOGIN[target.kind];
    const script = await this.deps.readWrapper(target.wrapper);
    const viaWrapper = script !== undefined;
    const executable = viaWrapper ? target.wrapper : this.deps.which(spec.binary);
    if (executable === undefined) {
      return {
        status: 'failed',
        message: `neither this account's wrapper nor the "${spec.binary}" CLI is on this host — run "fy fleet apply", or log this account in on a host that has the CLI and rerun to copy the credential across`,
      };
    }

    const environment = sanitizeHarnessEnv(this.deps.environment, script === undefined ? [] : referencedEnvNames(script));
    const started = this.deps.spawn([executable, spec.argument], {
      environment,
      ...(this.deps.cwd === undefined ? {} : { cwd: this.deps.cwd }),
    });
    const code = await started.exited;
    return code === 0 ? { status: 'logged-in' } : { status: 'failed', message: `login process exited with code ${code}` };
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
  try {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : undefined;
  } catch {
    return undefined;
  }
};

/** The harness CLI on `PATH`, or nothing. */
export const whichHarnessBinary: FleetBinaryLookup = binary => Bun.which(binary) ?? undefined;
