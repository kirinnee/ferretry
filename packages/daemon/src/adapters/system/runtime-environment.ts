import { homedir } from 'node:os';
import type { EnvironmentPort, StateHomeInput } from '../../lib/index.ts';

/**
 * The relay directory's origin, baked in at build time, or nothing.
 *
 * `scripts/release/compile.sh` replaces this identifier with a string literal from
 * `FY_RELAY_DIRECTORY_ORIGIN`, resolved by `scripts/ci/relay-directory-origin.sh` — the same script,
 * from the same inputs, that the PWA's Pages build uses, so the two halves of one carrier cannot be
 * pointed at different directories. Read through `typeof` because every other consumer of this
 * module — the test tiers, a plain `bun run` of the daemon — has no such define, and a free
 * identifier would throw rather than degrade.
 *
 * IT IS AN ORIGIN, NOT A CARRIER. It identifies the directory that serves the advertisement; the
 * relay address and the kill switch both live behind it, at runtime, which is what lets the operator
 * withdraw the carrier without a release. An empty string is the unset case and deliberately not a
 * URL: there is no fallback literal here and nothing invents a hostname.
 */
declare const __FY_RELAY_DIRECTORY__: string | undefined;

const compiledRelayDirectory = (): string | undefined => {
  const configured = typeof __FY_RELAY_DIRECTORY__ === 'string' ? __FY_RELAY_DIRECTORY__ : '';
  return configured === '' ? undefined : configured;
};

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
   * THE ENVIRONMENT WINS OVER THE BUILD, and that is the useful direction: a build carries the
   * origin the release was cut against, and somebody running from source, running a fork, or
   * pointing a daemon at their own directory has no build to change. It is the same escape hatch
   * `FY_HOME` already is, and it names a service rather than a secret.
   */
  relayDirectoryOrigin(): string | undefined {
    const configured = this.values.FY_RELAY_DIRECTORY_ORIGIN;
    if (configured !== undefined && configured.trim() !== '') return configured.trim();
    return compiledRelayDirectory();
  }
}
