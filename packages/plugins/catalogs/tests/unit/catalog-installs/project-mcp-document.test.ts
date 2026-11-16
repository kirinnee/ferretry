import { describe, expect, it } from 'bun:test';
import {
  McpProjectFileError,
  parseMcpProjectFile,
  projectEntry,
  renderMcpProjectFile,
} from '../../../daemon/lib/project-mcp-document.ts';

describe('parseMcpProjectFile', () => {
  it('reads no file, and a blank file, as an empty document', () => {
    expect(parseMcpProjectFile(null)).toEqual({});
    expect(parseMcpProjectFile('  \n')).toEqual({});
  });

  it('keeps every key the file already has', () => {
    const text = '{"other":1,"mcpServers":{"a":{"command":"x"}}}';
    expect(parseMcpProjectFile(text)).toEqual({ other: 1, mcpServers: { a: { command: 'x' } } });
  });

  it('refuses text that is not JSON, without rewriting it', () => {
    expect(() => parseMcpProjectFile('{nope')).toThrow(McpProjectFileError);
    expect(() => parseMcpProjectFile('{nope')).toThrow('not valid JSON');
  });

  it('refuses JSON that is not an object', () => {
    expect(() => parseMcpProjectFile('[]')).toThrow('not a JSON object');
    expect(() => parseMcpProjectFile('3')).toThrow('not a JSON object');
    expect(() => parseMcpProjectFile('null')).toThrow('not a JSON object');
  });

  it('refuses an mcpServers that is not an object', () => {
    expect(() => parseMcpProjectFile('{"mcpServers":[]}')).toThrow('"mcpServers" that is not an object');
  });
});

describe('projectEntry', () => {
  it('spells a url server as an http entry', () => {
    expect(projectEntry({ transport: 'url', url: 'https://mcp.example.test', oauth: false })).toEqual({
      type: 'http',
      url: 'https://mcp.example.test',
    });
  });

  it('spells a command server with its args, and its env only when it has some', () => {
    expect(projectEntry({ transport: 'command', command: 'acme', args: ['--x'], env: {} })).toEqual({
      command: 'acme',
      args: ['--x'],
    });
    expect(projectEntry({ transport: 'command', command: 'acme', args: [], env: { A: '1' } })).toEqual({
      command: 'acme',
      args: [],
      env: { A: '1' },
    });
  });
});

describe('renderMcpProjectFile', () => {
  it('writes two-space JSON and a final newline', () => {
    expect(renderMcpProjectFile({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});
