/**
 * What the daemon reads out of its environment, and what it refuses to invent.
 *
 * Two values, and both are addresses somebody has to be able to override: the state home, and the
 * origin of the relay directory this daemon asks whether a carrier is advertised. Neither has a
 * literal fallback compiled in — a build that was given no directory asks nobody anything and says
 * so on the boot trail, which is the honest degradation rather than a guessed hostname.
 */

import { describe, it } from 'bun:test';
import { HOSTED_RELAY_DIRECTORY_ORIGIN } from '@ferretry/relay';
import should from 'should';
import { RuntimeEnvironment } from '../../../src/adapters/system/runtime-environment.ts';

const environment = (values: Readonly<Record<string, string | undefined>>) =>
  new RuntimeEnvironment(values, () => '/home/someone');

describe('the daemon runtime environment', () => {
  it('should hand the state home decision its two inputs, unresolved', () => {
    // Assert — the resolution itself is the domain's; this only reports what it was given.
    should(environment({ FY_HOME: '/tmp/elsewhere' }).stateHomeInput()).deepEqual({
      fyHome: '/tmp/elsewhere',
      homeDirectory: '/home/someone',
    });
    should(environment({}).stateHomeInput()).deepEqual({ fyHome: undefined, homeDirectory: '/home/someone' });
  });

  it('should let the environment override the shared compiled relay directory', () => {
    should(environment({ FY_RELAY_DIRECTORY_ORIGIN: 'https://relay.example' }).relayDirectoryOrigin()).equal(
      'https://relay.example',
    );
    should(environment({ FY_RELAY_DIRECTORY_ORIGIN: '  https://relay.example  ' }).relayDirectoryOrigin()).equal(
      'https://relay.example',
    );
    should(environment({ FY_RELAY_DIRECTORY_ORIGIN: '   ' }).relayDirectoryOrigin()).equal(
      HOSTED_RELAY_DIRECTORY_ORIGIN,
    );
    // Every route imports the one shared source default. A missing directory is now reachable only
    // in a pre-default binary or a test double that explicitly returns NO_RELAY_DIRECTORY.
    should(environment({}).relayDirectoryOrigin()).equal(HOSTED_RELAY_DIRECTORY_ORIGIN);
  });
});
