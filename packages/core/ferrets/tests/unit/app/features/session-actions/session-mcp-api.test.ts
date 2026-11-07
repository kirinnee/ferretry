import { describe, expect, it } from 'bun:test';
import type { SessionMcpPreviewRequest } from '@ferretry/protocol';
import {
  addSessionMcp,
  previewSessionMcp,
  readSessionMcp,
} from '../../../../src/features/session-actions/session-mcp-api.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../../src/lib/daemon-scope.ts';
import { type DaemonFetch, DaemonResponseError } from '../../../../src/lib/runtime-models.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'a-token' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'b-token' });
const scopeA = daemonSessionScope(daemonA, 'ses/1');
const scopeB = daemonSessionScope(daemonB, 'ses/1');
const ETAG = 'a'.repeat(64);
const REQUEST: SessionMcpPreviewRequest = {
  name: 'acme',
  server: { transport: 'command', command: 'npx', args: ['acme'], env: {} },
};

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
  readonly signal: AbortSignal | null | undefined;
}

function recording(status: number, body: unknown): { fetcher: DaemonFetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        signal: init?.signal,
      });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    },
  };
}

const rejection = async (work: Promise<unknown>): Promise<DaemonResponseError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DaemonResponseError);
  return error as DaemonResponseError;
};

describe('the session MCP dials', () => {
  it('reads the listing from the paired daemon, with the caller signal', async () => {
    // Arrange
    const listing = { project: { path: '/r/.mcp.json', etag: null, servers: [] } };
    const { fetcher, calls } = recording(200, listing);
    const signal = new AbortController().signal;

    // Act
    const answer = await readSessionMcp(daemonA, scopeA, fetcher, signal);
    await readSessionMcp(daemonA, scopeA, fetcher);

    // Assert
    expect(answer).toEqual(listing);
    expect(calls.map(call => [call.url, call.method])).toEqual([
      ['https://a.example.test/v1/sessions/ses%2F1/mcp', 'GET'],
      ['https://a.example.test/v1/sessions/ses%2F1/mcp', 'GET'],
    ]);
    expect(calls[0]?.signal).toBe(signal);
    expect(calls[1]?.signal).toBeUndefined();
  });

  it('dials each scope at its own preview route and sends only the name and the server', async () => {
    // Arrange
    const project = recording(200, { scope: 'project', path: '/r/.mcp.json', etag: null, replaces: false, diff: [] });
    const login = recording(200, { scope: 'login', runtime: 'r', profile: 'p', replaces: false, ferrets: 2 });
    const signal = new AbortController().signal;

    // Act
    const projectPreview = await previewSessionMcp(daemonA, scopeA, 'project', REQUEST, project.fetcher, signal);
    const loginPreview = await previewSessionMcp(daemonA, scopeA, 'login', REQUEST, login.fetcher);

    // Assert
    expect(projectPreview.scope).toBe('project');
    expect(loginPreview).toEqual({ scope: 'login', runtime: 'r', profile: 'p', replaces: false, ferrets: 2 });
    expect([...project.calls, ...login.calls].map(call => [call.url, call.method, call.body])).toEqual([
      ['https://a.example.test/v1/sessions/ses%2F1/mcp/project/preview', 'POST', REQUEST],
      ['https://a.example.test/v1/sessions/ses%2F1/mcp/login/preview', 'POST', REQUEST],
    ]);
    expect(project.calls[0]?.signal).toBe(signal);
  });

  it('adds to the project with the previewed etag, and to the login without one', async () => {
    // Arrange
    const project = recording(200, { scope: 'project', name: 'acme', path: '/r/.mcp.json', etag: ETAG });
    const login = recording(200, { scope: 'login', name: 'acme', runtime: 'r', profile: 'p' });

    // Act
    const projectAdded = await addSessionMcp(daemonA, scopeA, 'project', { ...REQUEST, etag: null }, project.fetcher);
    const loginAdded = await addSessionMcp(daemonA, scopeA, 'login', { ...REQUEST, etag: ETAG }, login.fetcher);

    // Assert
    expect(projectAdded).toEqual({ scope: 'project', name: 'acme', path: '/r/.mcp.json', etag: ETAG });
    expect(loginAdded.scope).toBe('login');
    expect([...project.calls, ...login.calls].map(call => [call.url, call.method, call.body])).toEqual([
      ['https://a.example.test/v1/sessions/ses%2F1/mcp/project', 'POST', { ...REQUEST, etag: null }],
      ['https://a.example.test/v1/sessions/ses%2F1/mcp/login', 'POST', REQUEST],
    ]);
  });

  it("surfaces the daemon's own sentence and code when it refuses", async () => {
    // Arrange
    const changed = recording(409, {
      error: '.mcp.json changed since the preview. Review the new diff, then add the server again.',
      code: 'mcp_file_changed',
    });
    const bare = recording(500, 'not json');

    // Act
    const refused = await rejection(
      addSessionMcp(daemonA, scopeA, 'project', { ...REQUEST, etag: ETAG }, changed.fetcher),
    );
    const broken = await rejection(readSessionMcp(daemonA, scopeA, bare.fetcher));

    // Assert
    expect([refused.status, refused.code, refused.message]).toEqual([
      409,
      'mcp_file_changed',
      '.mcp.json changed since the preview. Review the new diff, then add the server again.',
    ]);
    expect([broken.status, broken.code, broken.message]).toEqual([500, undefined, 'HTTP 500']);
  });

  it('refuses a body it cannot read, an answer for the other scope, and a scope from another daemon', async () => {
    // Arrange
    const garbled = recording(200, { project: 'nope' });
    const unparsable = recording(200, 'not json');
    const crossed = recording(200, { scope: 'login', runtime: 'r', profile: 'p', replaces: false, ferrets: 0 });
    const crossedAdd = recording(200, { scope: 'project', name: 'acme', path: '/r/.mcp.json', etag: ETAG });

    // Act
    const unreadable = await rejection(readSessionMcp(daemonA, scopeA, garbled.fetcher));
    const notJson = await rejection(readSessionMcp(daemonA, scopeA, unparsable.fetcher));
    const otherScope = await rejection(previewSessionMcp(daemonA, scopeA, 'project', REQUEST, crossed.fetcher));
    const otherAdd = await rejection(addSessionMcp(daemonA, scopeA, 'login', REQUEST, crossedAdd.fetcher));

    // Assert
    expect([unreadable.status, notJson.status]).toEqual([502, 502]);
    expect(otherScope.message).toBe('the daemon answered for login when project was asked');
    expect(otherAdd.message).toBe('the daemon answered for project when login was asked');
    expect(() => readSessionMcp(daemonA, scopeB, garbled.fetcher)).toThrow('MCP scope must belong');
    await expect(previewSessionMcp(daemonA, scopeB, 'login', REQUEST, garbled.fetcher)).rejects.toThrow(
      'MCP scope must belong',
    );
    await expect(addSessionMcp(daemonA, scopeB, 'login', REQUEST, garbled.fetcher)).rejects.toThrow(
      'MCP scope must belong',
    );
  });
});
