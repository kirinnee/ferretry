import { homedir } from 'node:os';
import { HOSTED_RELAY_DIRECTORY_ORIGIN } from '@ferretry/relay';
import type { EnvironmentPort, StateHomeInput } from '../../lib/index.ts';

/**
 * The relay directory's origin, compiled into the shared relay source.
 *
 * `HOSTED_RELAY_DIRECTORY_ORIGIN` belongs to `@ferretry/relay`, so the daemon and PWA compile the
 * same fact on every route — Nix, GoReleaser, local Bun builds, and forks. The temporary owner
 * decision to use Ferretry's personal workers.dev hostname is documented beside that single
 * constant, including the planned move to a product domain and the accepted fork trade-off.
 *
 * IT IS AN ORIGIN, NOT A CARRIER. It identifies the directory that serves the advertisement; the
 * relay address and the kill switch both live behind it, at runtime, which is what lets the operator
 * withdraw the carrier without a release. `FY_RELAY_DIRECTORY_ORIGIN` remains the explicit runtime
 * override for an operator who needs a different directory.
 */
const compiledRelayDirectory = (): string => HOSTED_RELAY_DIRECTORY_ORIGIN;

export class RuntimeEnvironment implements EnvironmentPort {
  constructor(
    private readonly values: Readonly<Record<string, string | undefined>> = process.env,
    private readonly userHome: () => string = homedir,
  ) {}

  stateHomeInput(): StateHomeInput {
    return {
      fyHome: this.values.FY_HOME,
      homeDirectory: this.userHome(),
    };
  }

  /**
   * Where this daemon asks which carrier is advertised.
   *
   * THE ENVIRONMENT WINS OVER THE BUILD, so somebody running a fork or pointing a daemon at their
   * own directory has an explicit escape hatch without recompiling. It is a service address, not a
   * secret, and an explicit daemon configuration still wins before discovery is considered.
   */
  relayDirectoryOrigin(): string | undefined {
    const configured = this.values.FY_RELAY_DIRECTORY_ORIGIN;
    if (configured !== undefined && configured.trim() !== '') return configured.trim();
    return compiledRelayDirectory();
  }
}
