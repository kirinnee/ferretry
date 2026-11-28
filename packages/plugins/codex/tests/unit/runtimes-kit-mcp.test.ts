import { describe, expect, it } from 'bun:test';
import { codexRuntimesKit } from '../../daemon/lib/runtimes-kit/index.ts';
import { codexMcpKit } from '../../daemon/lib/runtimes-kit/mcp.ts';

const NONE = { literal: {}, forwarded: [] } as const;
const render = codexMcpKit.renderMcpServer!;
const documents = codexMcpKit.configDocuments!;
const plumbing = codexMcpKit.plumbing!;

describe('the Codex kit MCP rendering', () => {
  it('should be part of the kit Codex hands Runtimes', () => {
    expect(codexRuntimesKit.renderMcpServer).toBe(codexMcpKit.renderMcpServer);
    expect(codexRuntimesKit.configDocuments).toBe(codexMcpKit.configDocuments);
    expect(codexRuntimesKit.plumbing).toBe(codexMcpKit.plumbing);
  });

  it('should write a started command with no args or env key when it has none', () => {
    expect(render({ command: 'golden-server' }, NONE)).toEqual({ command: 'golden-server' });
    expect(render({ command: 'golden-server', args: [] }, NONE)).toEqual({ command: 'golden-server' });
  });

  it('should write literal variables in env and forwarded ones by name in env_vars', () => {
    expect(
      render(
        { command: 'npx', args: ['server-files', '--root', '/srv/files'] },
        { literal: { FILES_MODE: 'read' }, forwarded: ['FILES_TOKEN'] },
      ),
    ).toEqual({
      command: 'npx',
      args: ['server-files', '--root', '/srv/files'],
      env: { FILES_MODE: 'read' },
      env_vars: ['FILES_TOKEN'],
    });
  });

  it('should write a url as is, whatever its transport, and name the token variable of a signed-in server, never a value', () => {
    expect(render({ url: 'https://docs.example.test/mcp' }, NONE)).toEqual({ url: 'https://docs.example.test/mcp' });
    expect(render({ url: 'https://feed.example.test/sse' }, NONE)).toEqual({ url: 'https://feed.example.test/sse' });
    expect(render({ url: 'https://notes.example.test/mcp', auth: 'oauth' }, NONE, 'FY_MCP_TOKEN_NOTES')).toEqual({
      url: 'https://notes.example.test/mcp',
      bearer_token_env_var: 'FY_MCP_TOKEN_NOTES',
    });
  });
});

describe('the Codex kit config documents', () => {
  it('should add the servers to the mcp_servers table, beside the ones the settings already hold', () => {
    const settings = { model: 'x', mcp_servers: { own: { command: 'keep' }, files: { command: 'old' } } };
    const servers = { files: { command: 'files' }, extra: { url: 'https://e.example.test/mcp' } };
    expect(documents({ settings, servers })).toEqual({
      settings: {
        model: 'x',
        mcp_servers: {
          own: { command: 'keep' },
          files: { command: 'files' },
          extra: { url: 'https://e.example.test/mcp' },
        },
      },
      serversAt: ['mcp_servers'],
    });
  });

  it('should add no table when the profile has no servers, and replace one that is not a table', () => {
    const settings = { model: 'x', mcp_servers: 'none' };
    expect(documents({ settings, servers: {} })).toEqual({ settings, serversAt: ['mcp_servers'] });
    expect(documents({ settings, servers: { files: { command: 'files' } } }).settings).toEqual({
      model: 'x',
      mcp_servers: { files: { command: 'files' } },
    });
  });

  it('should write no second document, and leave a hooks block out of config.toml', () => {
    const result = documents({ settings: {}, servers: { files: { command: 'f' } }, hooksBlock: { PreToolUse: [] } });
    expect(result.claudeJson).toBeUndefined();
    expect(result.settings).toEqual({ mcp_servers: { files: { command: 'f' } } });
  });
});

describe('the Codex kit plumbing', () => {
  it('should keep the sign-in in auth.json and share one history directory, each replacing the persons own', () => {
    expect(plumbing({ settings: {}, sqliteHome: '/fy/fleet/sqlite' })).toEqual([
      {
        key: 'cli_auth_credentials_store',
        path: ['cli_auth_credentials_store'],
        value: 'file',
        replacesOwn: true,
      },
      { key: 'sqlite_home', path: ['sqlite_home'], value: '/fy/fleet/sqlite', replacesOwn: true },
    ]);
  });

  it('should write nothing when Runtimes names no history directory', () => {
    expect(plumbing({ settings: {} })).toEqual([]);
  });
});
