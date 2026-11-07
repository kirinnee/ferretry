import { describe, it } from 'bun:test';
import type { SessionMcpServer } from '@ferretry/protocol';
import should from 'should';
import {
  hasProjectServer,
  lineDiff,
  McpProjectFileError,
  parseMcpProjectFile,
  projectEntry,
  projectServers,
  renderMcpProjectFile,
  withProjectServer,
} from '../../../src/lib/session-mcp/project-file.ts';

const COMMAND: SessionMcpServer = { transport: 'command', command: 'npx', args: ['-y', 'acme'], env: {} };

describe('a project .mcp.json as data', () => {
  it('should read no file, an empty file and a real one', () => {
    // Act + Assert
    should(parseMcpProjectFile(null)).deepEqual({});
    should(parseMcpProjectFile('  \n')).deepEqual({});
    should(parseMcpProjectFile('{"mcpServers":{"a":{"command":"x"}},"other":1}')).deepEqual({
      mcpServers: { a: { command: 'x' } },
      other: 1,
    });
  });

  it('should refuse a file it would have to repair, each with its reason', () => {
    // Arrange
    const refusals = ['{', '[1]', '{"mcpServers":[]}'].map(text => {
      try {
        parseMcpProjectFile(text);
        return undefined;
      } catch (error) {
        return error;
      }
    });

    // Assert
    for (const refusal of refusals) should(refusal).be.instanceOf(McpProjectFileError);
    should(refusals.map(refusal => (refusal as Error).message)).deepEqual([
      '.mcp.json is not valid JSON, so Ferretry will not rewrite it. Fix it, then try again.',
      '.mcp.json is not a JSON object, so Ferretry will not rewrite it.',
      '.mcp.json has an "mcpServers" that is not an object, so Ferretry will not rewrite it.',
    ]);
  });

  it('should list the servers name-sorted with how each is reached', () => {
    // Arrange
    const document = parseMcpProjectFile(
      JSON.stringify({ mcpServers: { zeta: { url: 'https://z' }, alpha: { command: 'a' }, odd: 7 } }),
    );

    // Act + Assert
    should(projectServers(document)).deepEqual([
      { name: 'alpha', transport: 'command' },
      { name: 'odd', transport: 'command' },
      { name: 'zeta', transport: 'url' },
    ]);
    should(projectServers({})).deepEqual([]);
    should(hasProjectServer(document, 'alpha')).be.true();
    should(hasProjectServer(document, 'beta')).be.false();
    should(hasProjectServer({}, 'alpha')).be.false();
  });

  it('should spell a server the way Claude Code reads it', () => {
    // Act + Assert
    should(projectEntry({ transport: 'url', url: 'https://mcp.example.com', oauth: false })).deepEqual({
      type: 'http',
      url: 'https://mcp.example.com',
    });
    should(projectEntry(COMMAND)).deepEqual({ command: 'npx', args: ['-y', 'acme'] });
    should(projectEntry({ ...COMMAND, env: { REGION: 'eu' } })).deepEqual({
      command: 'npx',
      args: ['-y', 'acme'],
      env: { REGION: 'eu' },
    });
  });

  it('should set one server and keep every other key where it was', () => {
    // Arrange
    const document = { $schema: 's', mcpServers: { old: { command: 'o' } }, trailing: true };

    // Act
    const added = withProjectServer(document, 'acme', COMMAND);
    const fresh = withProjectServer({}, 'acme', COMMAND);

    // Assert
    should(Object.keys(added)).deepEqual(['$schema', 'mcpServers', 'trailing']);
    should(added.mcpServers).deepEqual({ old: { command: 'o' }, acme: { command: 'npx', args: ['-y', 'acme'] } });
    should(renderMcpProjectFile(fresh)).equal(
      '{\n  "mcpServers": {\n    "acme": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "acme"\n      ]\n    }\n  }\n}\n',
    );
  });
});

describe('the diff a person approves', () => {
  it('should show a new file as every line added', () => {
    // Act
    const diff = lineDiff('', '{\n  "a": 1\n}\n');

    // Assert
    should(diff).deepEqual([
      { kind: 'add', text: '{' },
      { kind: 'add', text: '  "a": 1' },
      { kind: 'add', text: '}' },
    ]);
  });

  it('should fold a long unchanged run into one line and keep three lines of context', () => {
    // Arrange
    const before = ['{', 'a', 'b', 'c', 'd', 'e', 'f', 'g', '}'].join('\n');
    const after = ['{', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'NEW', '}'].join('\n');

    // Act
    const diff = lineDiff(before, after);

    // Assert
    should(diff).deepEqual([
      { kind: 'context', text: '…' },
      { kind: 'context', text: 'e' },
      { kind: 'context', text: 'f' },
      { kind: 'context', text: 'g' },
      { kind: 'add', text: 'NEW' },
      { kind: 'context', text: '}' },
    ]);
  });

  it('should show a replaced line as removed, then added', () => {
    // Act
    const diff = lineDiff('{\n  "x": 1\n}\n', '{\n  "x": 2\n}\n');

    // Assert
    should(diff).deepEqual([
      { kind: 'context', text: '{' },
      { kind: 'remove', text: '  "x": 1' },
      { kind: 'add', text: '  "x": 2' },
      { kind: 'context', text: '}' },
    ]);
  });

  it('should show a line that went away as removed', () => {
    // Act
    const diff = lineDiff('a\nb\nc\n', 'a\nc\n');

    // Assert
    should(diff).deepEqual([
      { kind: 'context', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'context', text: 'c' },
    ]);
  });
});
