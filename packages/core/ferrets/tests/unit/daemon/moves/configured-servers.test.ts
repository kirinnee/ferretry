import { describe, it } from 'bun:test';
import should from 'should';
import { configuredServersOf } from '../../../src/lib/migrate/configured-servers.ts';

describe('the servers a project configures', () => {
  it('should read command servers and skip url servers and malformed entries', () => {
    // Arrange
    const text = JSON.stringify({
      mcpServers: {
        search: { command: 'npx', args: ['-y', '@acme/search-mcp', 7] },
        bare: { command: '/usr/local/bin/lsp-lite' },
        remote: { type: 'http', url: 'https://example.invalid/mcp' },
        empty: { command: '' },
        scalar: 'not-an-object',
      },
    });

    // Act
    const actual = configuredServersOf(text);

    // Assert
    should(actual).deepEqual([
      { name: 'search', command: 'npx', args: ['-y', '@acme/search-mcp'] },
      { name: 'bare', command: '/usr/local/bin/lsp-lite', args: [] },
    ]);
  });

  it('should declare nothing for a missing, empty, unparseable or oddly shaped file', () => {
    // Act
    const actual = [null, '', '{ not json', '[]', '{"mcpServers": []}', '{}'].map(configuredServersOf);

    // Assert
    should(actual).deepEqual([[], [], [], [], [], []]);
  });
});
