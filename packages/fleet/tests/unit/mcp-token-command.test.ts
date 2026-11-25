import { describe, it } from 'bun:test';
import should from 'should';
import { claudeMcpTokenCommand } from '../../src/lib/mcp-token-command.ts';

describe('claudeMcpTokenCommand', () => {
  it('should spell the headersHelper as the binary, quoted, then `mcp token` and the variable', () => {
    // Act
    const actual = claudeMcpTokenCommand('fy', 'FY_MCP_SLACK_0123456789ABCDEF_TOKEN');

    // Assert
    should(actual).equal("'fy' mcp token FY_MCP_SLACK_0123456789ABCDEF_TOKEN");
  });

  it('should quote a binary path with a space so the shell runs it as one word', () => {
    // Act
    const actual = claudeMcpTokenCommand('/opt/my tools/fy', 'FY_MCP_X_0123456789ABCDEF_TOKEN');

    // Assert
    should(actual).equal("'/opt/my tools/fy' mcp token FY_MCP_X_0123456789ABCDEF_TOKEN");
  });
});
