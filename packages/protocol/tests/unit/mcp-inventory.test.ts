import { describe, it } from 'bun:test';
import should from 'should';
import {
  MCP_CHECK_TOOL_NAMES,
  McpCheckResultSchema,
  McpInventorySchema,
  mcpOAuthSecretNames,
  mcpProjectSubject,
  parseMcpProjectSubject,
} from '../../src/lib/index.ts';

describe('the MCP inventory contract', () => {
  it('should spell a project server’s sign-in subject so no component name can ever be one', () => {
    // Act
    const subject = mcpProjectSubject('docs', 'a1b2c3d4e5f6');

    // Assert — `..` is refused in a component name (SafeNameSchema), so this is unambiguous.
    should(subject).equal('docs..a1b2c3d4e5f6');
    should(parseMcpProjectSubject(subject)).deepEqual({ name: 'docs', projectKey: 'a1b2c3d4e5f6' });
    should(parseMcpProjectSubject('my.server..a1b2c3d4e5f6')).deepEqual({
      name: 'my.server',
      projectKey: 'a1b2c3d4e5f6',
    });
    should(parseMcpProjectSubject('linear')).be.null();
    should(parseMcpProjectSubject('..a1b2c3d4e5f6')).be.null();
    should(parseMcpProjectSubject('docs..NOT-HEX')).be.null();
  });

  it('should file a project server’s tokens under its own names, apart from a same-named component', () => {
    // Act
    const project = mcpOAuthSecretNames(mcpProjectSubject('linear', 'a1b2c3d4e5f6'), 'https://mcp.linear.app/mcp');
    const component = mcpOAuthSecretNames('linear', 'https://mcp.linear.app/mcp');

    // Assert
    should(project.access).not.equal(component.access);
    // The readable stem is the subject cut to 16 characters; the digest binds all of it and the address.
    should(project.access).match(/^MCP_LINEAR_A1B2C3D4E_[0-9A-F]{16}_ACCESS$/u);
    should(project.variable).startWith('FY_MCP_LINEAR_');
  });

  it('should parse an inventory and a check, and refuse a check carrying more than the capped tool names', () => {
    // Arrange
    const server = {
      id: 'abc',
      name: 'docs',
      scope: 'project',
      harness: 'claude',
      transport: 'http',
      target: 'https://docs.example.com/mcp',
      source: '/work/app/.mcp.json',
      project: { root: '/work/app' },
      runtimes: [{ runtime: 'claude-work', approval: 'pending' }],
      signIn: { subject: 'docs..a1b2c3d4e5f6', required: false },
    };
    const check = {
      id: 'abc',
      name: 'docs',
      transport: 'http',
      outcome: 'connected',
      toolCount: 2,
      tools: ['a', 'b'],
      elapsedMs: 12,
      checkedAt: '2026-10-24T00:00:00.000Z',
    };

    // Act / Assert
    should(McpInventorySchema.safeParse({ servers: [server], problems: [] }).success).be.true();
    should(
      McpInventorySchema.safeParse({ servers: [{ ...server, scope: 'global' }], problems: [] }).success,
    ).be.false();
    should(McpCheckResultSchema.safeParse(check).success).be.true();
    should(
      McpCheckResultSchema.safeParse({ ...check, tools: Array.from({ length: MCP_CHECK_TOOL_NAMES + 1 }, () => 't') })
        .success,
    ).be.false();
  });
});
