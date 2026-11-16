import { describe, expect, test } from 'bun:test';
import { parseHarnessDocument } from '../../daemon/lib/inventory/parse-document.ts';

describe('parsing a harness document', () => {
  test('JSON text is parsed as JSON', () => {
    expect(parseHarnessDocument('{"mcpServers":{"docs":{"url":"https://docs.example.com/mcp"}}}', 'json')).toEqual({
      mcpServers: { docs: { url: 'https://docs.example.com/mcp' } },
    });
  });

  test('TOML text is parsed as TOML: Codex’s [mcp_servers.<name>] tables, arrays and nested tables', () => {
    const text = [
      'model = "gpt"',
      '[mcp_servers.docs]',
      'url = "https://docs.example.com/mcp"',
      '[mcp_servers.tool]',
      'command = "npx"',
      'args = ["tool", "-y"]',
      '[mcp_servers.tool.env]',
      'KEY = "value"',
    ].join('\n');
    expect(parseHarnessDocument(text, 'toml')).toEqual({
      model: 'gpt',
      mcp_servers: {
        docs: { url: 'https://docs.example.com/mcp' },
        tool: { command: 'npx', args: ['tool', '-y'], env: { KEY: 'value' } },
      },
    });
  });

  test('text that is not in the format throws, for the reader to say so without quoting it', () => {
    expect(() => parseHarnessDocument('{ not json', 'json')).toThrow();
    expect(() => parseHarnessDocument('[mcp_servers', 'toml')).toThrow();
  });
});
