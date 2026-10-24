import { describe, it } from 'bun:test';
import should from 'should';
import * as mcp from '../../src/lib/session-mcp.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

/** `${secret:NAME}` and `${NAME}`, spelled without a string the linter reads as a mistaken template. */
const secretRef = (name: string): string => `\${secret:${name}}`;
const envRef = (name: string): string => `\${${name}}`;
const ETAG = 'a'.repeat(64);
const COMMAND: mcp.SessionMcpServer = {
  transport: 'command',
  command: 'npx',
  args: ['-y', '@acme/mcp'],
  env: { REGION: 'eu' },
};
const URL_SERVER: mcp.SessionMcpServer = { transport: 'url', url: 'https://mcp.example.com/sse', oauth: true };

const cases: SchemaCase[] = [
  { name: 'scope', schema: mcp.SessionMcpScopeSchema, value: 'project' },
  { name: 'name', schema: mcp.SessionMcpNameSchema, value: 'github_2-x' },
  { name: 'env name', schema: mcp.SessionMcpEnvNameSchema, value: 'GITHUB_TOKEN' },
  { name: 'env', schema: mcp.SessionMcpEnvSchema, value: { A: '1', B_2: secretRef('B') } },
  { name: 'command server', schema: mcp.SessionMcpServerSchema, value: COMMAND },
  { name: 'preview request', schema: mcp.SessionMcpPreviewRequestSchema, value: { name: 'acme', server: URL_SERVER } },
  { name: 'etag', schema: mcp.SessionMcpEtagSchema, value: ETAG },
  {
    name: 'add request',
    schema: mcp.SessionMcpAddRequestSchema,
    value: { name: 'acme', server: COMMAND, etag: null },
  },
  { name: 'diff line', schema: mcp.SessionMcpDiffLineSchema, value: { kind: 'add', text: '  "acme": {' } },
  {
    name: 'project preview',
    schema: mcp.SessionMcpPreviewSchema,
    value: {
      scope: 'project',
      path: '/repo/.mcp.json',
      etag: null,
      replaces: false,
      diff: [{ kind: 'add', text: '{' }],
    },
  },
  {
    name: 'added',
    schema: mcp.SessionMcpAddedSchema,
    value: { scope: 'login', name: 'acme', runtime: 'claude-work', profile: 'default' },
  },
  { name: 'project server', schema: mcp.SessionMcpProjectServerSchema, value: { name: 'acme', transport: 'url' } },
  {
    name: 'listing',
    schema: mcp.SessionMcpListingSchema,
    value: { project: { path: '/repo/.mcp.json', etag: ETAG, servers: [{ name: 'acme', transport: 'command' }] } },
  },
];

describe('the session MCP protocol', () => {
  it('should round-trip every exported schema', () => {
    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(mcp, cases);
  });

  it('should round-trip the other arm of each union and an unavailable project', () => {
    // Act + Assert
    assertRoundTrips([
      { name: 'url server', schema: mcp.SessionMcpServerSchema, value: URL_SERVER },
      {
        name: 'login preview',
        schema: mcp.SessionMcpPreviewSchema,
        value: { scope: 'login', runtime: 'claude-work', profile: 'default', replaces: true, ferrets: 3 },
      },
      {
        name: 'project added',
        schema: mcp.SessionMcpAddedSchema,
        value: { scope: 'project', name: 'acme', path: '/repo/.mcp.json', etag: ETAG },
      },
      {
        name: 'no project',
        schema: mcp.SessionMcpListingSchema,
        value: { project: null, projectUnavailable: 'Codex does not read .mcp.json.' },
      },
      { name: 'add without etag', schema: mcp.SessionMcpAddRequestSchema, value: { name: 'acme', server: URL_SERVER } },
    ]);
  });

  it('should refuse names, addresses and fields outside the grammar', () => {
    // Act + Assert
    assertRejects([
      { name: 'leading dash', schema: mcp.SessionMcpNameSchema, value: '-acme' },
      { name: 'a slash', schema: mcp.SessionMcpNameSchema, value: 'a/b' },
      { name: 'too long', schema: mcp.SessionMcpNameSchema, value: `a${'b'.repeat(64)}` },
      { name: 'lower-case env name', schema: mcp.SessionMcpEnvNameSchema, value: 'token' },
      {
        name: 'javascript address',
        schema: mcp.SessionMcpServerSchema,
        value: { ...URL_SERVER, url: 'javascript:alert(1)' },
      },
      { name: 'empty command', schema: mcp.SessionMcpServerSchema, value: { ...COMMAND, command: '  ' } },
      { name: 'url with env', schema: mcp.SessionMcpServerSchema, value: { ...URL_SERVER, env: {} } },
      { name: 'upper-case etag', schema: mcp.SessionMcpEtagSchema, value: 'A'.repeat(64) },
      {
        name: 'scope in the body',
        schema: mcp.SessionMcpPreviewRequestSchema,
        value: { name: 'a', server: COMMAND, scope: 'login' },
      },
      { name: 'unknown diff kind', schema: mcp.SessionMcpDiffLineSchema, value: { kind: 'move', text: '' } },
      {
        name: 'negative ferrets',
        schema: mcp.SessionMcpPreviewSchema,
        value: { scope: 'login', runtime: 'r', profile: 'p', replaces: false, ferrets: -1 },
      },
    ]);
  });

  it('should name the project file the daemon writes', () => {
    should(mcp.SESSION_MCP_PROJECT_FILE).equal('.mcp.json');
  });
});

describe('the MCP environment rule both ends run', () => {
  it('should answer each value by scope', () => {
    // Arrange — [scope, name, value, refused?]
    const table: readonly (readonly [mcp.SessionMcpScope, string, string, RegExp | null])[] = [
      ['login', 'API_KEY', secretRef('ACME_KEY'), null],
      ['project', 'API_KEY', secretRef('ACME_KEY'), /Ferretry cannot fill in \$\{secret:…\} there/u],
      ['project', 'API_KEY', envRef('ACME_KEY'), null],
      ['project', 'API_KEY', envRef('ACME_KEY:-fallback'), null],
      ['project', 'REGION', 'eu-west-1', null],
      ['project', 'OPENAI_KEY', 'sk-abc', /looks like a raw secret, and \.mcp\.json is shared/u],
      ['login', 'ANYTHING', 'ghp_0123456789', /Run `fy secret set ANYTHING`/u],
      ['login', 'ACME_TOKEN', 'abcdefghijklmnop', /looks like a raw secret/u],
      ['login', 'ACME_TOKEN', 'short', null],
      ['login', 'ACME_TOKEN', 'a long value with spaces', null],
      ['login', 'ACME_AUTH', 'https://example.com/path/x', null],
      ['login', 'PLAIN', 'abcdefghijklmnopqrstuvwxyz', null],
    ];

    // Act + Assert
    for (const [scope, name, value, expected] of table) {
      const refusal = mcp.mcpEnvRefusal(scope, name, value);
      if (expected === null) should(refusal).be.null();
      else should(refusal).match(expected);
    }
  });

  it('should answer a whole server: its environment, its arguments, and sign-in by scope', () => {
    // Act + Assert
    should(mcp.mcpServerRefusal('project', COMMAND)).be.null();
    should(mcp.mcpServerRefusal('login', URL_SERVER)).be.null();
    should(mcp.mcpServerRefusal('project', { ...URL_SERVER, oauth: false })).be.null();
    should(mcp.mcpServerRefusal('project', URL_SERVER)).match(/has no sign-in switch/u);
    should(mcp.mcpServerRefusal('login', { ...COMMAND, env: { KEY: 'sk-live' } })).match(
      /KEY looks like a raw secret/u,
    );
    should(mcp.mcpServerRefusal('login', { ...COMMAND, args: ['--token', 'ghp_abc'] })).match(
      /An argument looks like a raw secret/u,
    );
  });
});
