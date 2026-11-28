import { describe, expect, it } from 'bun:test';
import { claudeRuntimesKit } from '../../daemon/lib/runtimes-kit/index.ts';
import { claudeMcpKit } from '../../daemon/lib/runtimes-kit/mcp.ts';

const NONE = { literal: {}, forwarded: [] } as const;
const render = claudeMcpKit.renderMcpServer!;
const documents = claudeMcpKit.configDocuments!;
const plumbing = claudeMcpKit.plumbing!;

describe('the Claude kit MCP rendering', () => {
  it('should be part of the kit Claude hands Runtimes', () => {
    expect(claudeRuntimesKit.renderMcpServer).toBe(claudeMcpKit.renderMcpServer);
    expect(claudeRuntimesKit.configDocuments).toBe(claudeMcpKit.configDocuments);
    expect(claudeRuntimesKit.plumbing).toBe(claudeMcpKit.plumbing);
  });

  it('should write a started command with no env key when it has no variables', () => {
    expect(render({ command: 'golden-server' }, NONE)).toEqual({ type: 'stdio', command: 'golden-server', args: [] });
  });

  it('should write literal variables as values and forwarded ones as ${NAME} references', () => {
    expect(
      render(
        { command: 'npx', args: ['server-files', '--root', '/srv/files'] },
        { literal: { FILES_MODE: 'read' }, forwarded: ['FILES_TOKEN'] },
      ),
    ).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['server-files', '--root', '/srv/files'],
      env: { FILES_MODE: 'read', FILES_TOKEN: '${FILES_TOKEN}' },
    });
  });

  it('should write a streamable-HTTP url as http and an SSE url as sse', () => {
    expect(render({ url: 'https://docs.example.test/mcp' }, NONE)).toEqual({
      type: 'http',
      url: 'https://docs.example.test/mcp',
    });
    expect(render({ url: 'https://feed.example.test/sse' }, NONE)).toEqual({
      type: 'sse',
      url: 'https://feed.example.test/sse',
    });
  });

  it('should name the token variable of a signed-in server in its Authorization header, never a value', () => {
    expect(render({ url: 'https://notes.example.test/mcp', auth: 'oauth' }, NONE, 'FY_MCP_TOKEN_NOTES')).toEqual({
      type: 'http',
      url: 'https://notes.example.test/mcp',
      headers: { Authorization: 'Bearer ${FY_MCP_TOKEN_NOTES}' },
    });
  });
});

describe('the Claude kit config documents', () => {
  it('should put the servers in .claude.json and leave the settings as they are', () => {
    const settings = { model: 'x' };
    const servers = { files: { type: 'stdio', command: 'files', args: [] } };
    expect(documents({ settings, servers })).toEqual({ settings, claudeJson: { mcpServers: servers } });
  });

  it('should carry a hooks block in the settings document', () => {
    const hooksBlock = { PreToolUse: [] };
    expect(documents({ settings: { model: 'x' }, servers: {}, hooksBlock })).toEqual({
      settings: { model: 'x', hooks: hooksBlock },
      claudeJson: { mcpServers: {} },
    });
  });

  it('should always write mcpServers, so a server removed from the profile leaves the file', () => {
    expect(documents({ settings: {}, servers: {} }).claudeJson).toEqual({ mcpServers: {} });
  });
});

describe('the Claude kit plumbing', () => {
  const statusLine = (own?: string) => (own === undefined ? 'fy statusline' : `fy statusline --chain ${own}`);

  it('should write the status line as a command', () => {
    expect(plumbing({ settings: {}, statusLine })).toEqual([
      { key: 'statusLine.type', path: ['statusLine', 'type'], value: 'command' },
      { key: 'statusLine.command', path: ['statusLine', 'command'], value: 'fy statusline' },
    ]);
  });

  it("should chain the person's own status line command and ignore a blank one", () => {
    const own = plumbing({ settings: { statusLine: { type: 'command', command: 'my-line' } }, statusLine });
    expect(own[1]?.value).toBe('fy statusline --chain my-line');
    const blank = plumbing({ settings: { statusLine: { command: '   ' } }, statusLine });
    expect(blank[1]?.value).toBe('fy statusline');
    expect(plumbing({ settings: { statusLine: 'text' }, statusLine })[1]?.value).toBe('fy statusline');
  });
});
