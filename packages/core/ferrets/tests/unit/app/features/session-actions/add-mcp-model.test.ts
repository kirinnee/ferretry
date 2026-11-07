import { describe, expect, it } from 'bun:test';
import {
  draftRequest,
  EMPTY_MCP_DRAFT,
  type McpDraft,
  parseEnvLines,
} from '../../../../src/features/session-actions/add-mcp-model.ts';

const draft = (overrides: Partial<McpDraft> = {}): McpDraft => ({ ...EMPTY_MCP_DRAFT, ...overrides });

/** `${inner}`, built by concatenation so the literal text never reads as an (accidental) interpolation. */
const ref = (inner: string): string => ['$', `{${inner}}`].join('');

describe('EMPTY_MCP_DRAFT', () => {
  it('starts on a project-scope command server with nothing filled in', () => {
    expect(EMPTY_MCP_DRAFT).toEqual({
      scope: 'project',
      transport: 'command',
      name: '',
      command: '',
      url: '',
      env: '',
      oauth: false,
    });
  });
});

describe('parseEnvLines', () => {
  it('reads an empty draft as no variables', () => {
    expect(parseEnvLines('')).toEqual({ env: {} });
  });

  it('skips blank lines and trims each value', () => {
    expect(parseEnvLines('\nTOKEN=abc  \n\n  REGION=us-east-1\n')).toEqual({
      env: { TOKEN: 'abc', REGION: 'us-east-1' },
    });
  });

  it('names the first line that is not NAME=value, with an upper-case NAME', () => {
    expect(parseEnvLines('TOKEN=abc\nnope')).toEqual({
      error: 'Line 2: use NAME=value, with an upper-case NAME.',
    });
  });

  it('rejects a lower-case name even when the shape otherwise matches', () => {
    expect(parseEnvLines('token=abc')).toEqual({ error: 'Line 1: use NAME=value, with an upper-case NAME.' });
  });

  it('allows an empty value', () => {
    expect(parseEnvLines('FLAG=')).toEqual({ env: { FLAG: '' } });
  });
});

describe('draftRequest — name', () => {
  it('is incomplete with no reason to show when the name is blank', () => {
    expect(draftRequest(draft())).toEqual({ kind: 'incomplete', reason: null });
  });

  it('refuses a name the protocol would reject, with the shape it wants', () => {
    expect(draftRequest(draft({ name: '-bad', command: 'npx server' }))).toEqual({
      kind: 'incomplete',
      reason: 'Name: use letters, digits, - and _, starting with a letter or digit.',
    });
  });
});

describe('draftRequest — a URL server', () => {
  const base = { name: 'sentry', transport: 'url' as const };

  it('is incomplete with no reason when the address is blank', () => {
    expect(draftRequest(draft(base))).toEqual({ kind: 'incomplete', reason: null });
  });

  it('refuses an address that is not http or https', () => {
    expect(draftRequest(draft({ ...base, url: 'ftp://mcp.sentry.dev' }))).toEqual({
      kind: 'incomplete',
      reason: 'URL: use an http:// or https:// address.',
    });
  });

  it('is ready once the name and address are both valid', () => {
    expect(draftRequest(draft({ ...base, url: 'https://mcp.sentry.dev/mcp' }))).toEqual({
      kind: 'ready',
      request: { name: 'sentry', server: { transport: 'url', url: 'https://mcp.sentry.dev/mcp', oauth: false } },
    });
  });

  it('carries oauth only on a login-scope server, never on a project one', () => {
    const login = draftRequest(draft({ ...base, scope: 'login', url: 'https://mcp.sentry.dev/mcp', oauth: true }));
    expect(login.kind === 'ready' && login.request.server.transport === 'url' && login.request.server.oauth).toBe(true);
    const project = draftRequest(draft({ ...base, scope: 'project', url: 'https://mcp.sentry.dev/mcp', oauth: true }));
    expect(project.kind === 'ready' && project.request.server.transport === 'url' && project.request.server.oauth).toBe(
      false,
    );
  });
});

describe('draftRequest — a command server', () => {
  const base = { name: 'sentry' };

  it('is incomplete with no reason when the command line is blank', () => {
    expect(draftRequest(draft(base))).toEqual({ kind: 'incomplete', reason: null });
  });

  it('surfaces a bad environment line as the reason', () => {
    expect(draftRequest(draft({ ...base, command: 'npx server', env: 'nope' }))).toEqual({
      kind: 'incomplete',
      reason: 'Line 1: use NAME=value, with an upper-case NAME.',
    });
  });

  it('splits the command line into a command and its arguments', () => {
    const result = draftRequest(draft({ ...base, command: 'npx -y @sentry/mcp-server' }));
    expect(result).toEqual({
      kind: 'ready',
      request: {
        name: 'sentry',
        server: { transport: 'command', command: 'npx', args: ['-y', '@sentry/mcp-server'], env: {} },
      },
    });
  });

  it('refuses a raw-looking secret on a project server, with the project’s own way out', () => {
    const result = draftRequest(draft({ ...base, command: 'npx server', env: 'TOKEN=1234567890abcdef' }));
    expect(result).toEqual({
      kind: 'incomplete',
      reason: `TOKEN looks like a raw secret, and .mcp.json is shared with everyone on the repo. Use ${ref('TOKEN')} instead, or add the server to This login with ${ref('secret:TOKEN')}.`,
    });
  });

  it('refuses the same raw-looking secret on a login server, with the login’s own way out', () => {
    const result = draftRequest(
      draft({ ...base, scope: 'login', command: 'npx server', env: 'TOKEN=1234567890abcdef' }),
    );
    expect(result).toEqual({
      kind: 'incomplete',
      reason: `TOKEN looks like a raw secret. Run \`fy secret set TOKEN\` and use ${ref('secret:TOKEN')} instead.`,
    });
  });

  it('refuses a secret-store reference on a project server, because Claude Code reads that file itself', () => {
    const result = draftRequest(draft({ ...base, command: 'npx server', env: `TOKEN=${ref('secret:TOKEN')}` }));
    expect(result).toEqual({
      kind: 'incomplete',
      reason: `TOKEN: a project's .mcp.json is shared with the repo and read by Claude Code itself, so Ferretry cannot fill in ${ref('secret:…')} there. Use ${ref('TOKEN')} and give the ferret that variable, or add the server to This login.`,
    });
  });

  it('allows the same secret-store reference on a login server', () => {
    const result = draftRequest(
      draft({ ...base, scope: 'login', command: 'npx server', env: `TOKEN=${ref('secret:TOKEN')}` }),
    );
    expect(result.kind).toBe('ready');
  });

  it('allows a plain environment reference in a project server', () => {
    const result = draftRequest(draft({ ...base, command: 'npx server', env: `REGION=${ref('REGION')}` }));
    expect(result.kind).toBe('ready');
  });
});
