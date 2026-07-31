import { describe, it } from 'bun:test';
import should from 'should';
import { USAGE_PROBE_FLAGS, usageProbeCommand } from '../../../src/lib/usage/index.ts';

describe('usageProbeCommand', () => {
  it('should refuse to build a probe when no command is configured', () => {
    // Arrange / Act / Assert — no fallback is a real configuration, not an error
    should(usageProbeCommand([])).be.undefined();
  });

  it('should refuse to build a probe from blank words alone', () => {
    // Arrange / Act / Assert
    should(usageProbeCommand(['  ', ''])).be.undefined();
  });

  it('should append the flags the daemon needs to the configured command', () => {
    // Arrange / Act
    const command = usageProbeCommand(['fleetctl', 'usage']);

    // Assert
    should(command).eql(['fleetctl', 'usage', '--json', '--all', '--no-relogin']);
  });

  it('should always ask for API-metered accounts, because hiding them under-reports billing', () => {
    // Arrange / Act
    const command = usageProbeCommand(['fleetctl', 'usage']);

    // Assert — without --all a collector omits usageBased:false rows entirely
    should(command).containEql('--all');
  });

  it('should not repeat a flag the operator already supplied', () => {
    // Arrange / Act
    const command = usageProbeCommand(['fleetctl', 'usage', '--all']);

    // Assert
    should(command?.filter(part => part === '--all')).have.length(1);
    should(command).eql(['fleetctl', 'usage', '--all', '--json', '--no-relogin']);
  });

  it('should trim the words it was given rather than pass whitespace to the shell', () => {
    // Arrange / Act
    const command = usageProbeCommand([' fleetctl ', '', ' usage ']);

    // Assert
    should(command?.slice(0, 2)).eql(['fleetctl', 'usage']);
  });

  it('should name every flag the daemon depends on', () => {
    // Arrange / Act / Assert — pinned so dropping one is a visible test change, not a silent regression
    should(USAGE_PROBE_FLAGS).eql(['--json', '--all', '--no-relogin']);
  });
});
