import { describe, it } from 'bun:test';
import should from 'should';
import { AllowedCommands } from '../../daemon/lib/allowed-commands.ts';
import manifest from '../../manifest.ts';

describe('AllowedCommands (the `mcp-commands` spawn resolver)', () => {
  it('should answer the configured servers’ commands and nothing else', () => {
    // Arrange
    const allowed = new AllowedCommands(() => ['npx', 'uvx']);

    // Act / Assert
    should(allowed.programs()).deepEqual(['npx', 'uvx']);
  });

  it('should allow the one command a check is starting until that check ends, once', () => {
    // Arrange
    const allowed = new AllowedCommands(() => ['npx']);

    // Act
    const release = allowed.allow('/opt/tool/server');
    const during = allowed.programs();
    release();
    release();

    // Assert
    should(during).deepEqual(['npx', '/opt/tool/server']);
    should(allowed.programs()).deepEqual(['npx']);
  });

  it('should keep a command while another check of the same one is still running', () => {
    // Arrange
    const allowed = new AllowedCommands(() => []);
    const first = allowed.allow('tool');
    const second = allowed.allow('tool');

    // Act
    first();

    // Assert
    should(allowed.programs()).deepEqual(['tool']);
    second();
    should(allowed.programs()).deepEqual([]);
  });

  it('should be the manifest’s only spawn allowance: no wildcard, no fixed program', () => {
    should(manifest.permissions?.spawn).deepEqual([{ resolver: 'mcp-commands' }]);
  });
});
