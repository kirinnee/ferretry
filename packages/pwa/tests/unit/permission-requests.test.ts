import { describe, expect, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER, type PermissionRequest } from '@ferretry/protocol';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  answerPermissionRequest,
  PERMISSION_PROMPT_GONE,
  PermissionPromptGone,
  permissionOptionWords,
  permissionPhrase,
  permissionSentence,
  permissionWords,
  shortPath,
  shortPermissionWhat,
} from '../../src/lib/permission-requests.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'token-b' });
const scopeA = daemonSessionScope(daemonA, 'shared/session');
const scopeB = daemonSessionScope(daemonB, 'shared/session');
const ID = '0123456789abcdef';

const request = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: ID,
  harness: 'claude',
  tool: 'Read',
  action: 'read',
  what: '/etc/hostname',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes', kind: 'allow' },
    { number: 2, label: 'Yes, allow reading from /etc during this session', kind: 'allow-always' },
    { number: 3, label: 'No', kind: 'deny' },
  ],
  selected: 1,
  ...overrides,
});

const recorder = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status });
  };
  return { calls, fetcher };
};

describe('answerPermissionRequest', () => {
  it('posts the answer to the session it belongs to and returns what the pane said', async () => {
    const { calls, fetcher } = recorder(200, { requestId: ID, cleared: true });
    expect(
      await answerPermissionRequest(daemonA, scopeA, { kind: 'choice', requestId: ID, number: 2 }, fetcher),
    ).toEqual({ requestId: ID, cleared: true });
    expect(calls[0]?.url).toBe('https://a.example.test/v1/sessions/shared%2Fsession/permission');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ kind: 'choice', requestId: ID, number: 2 });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get(FY_REQUEST_ID_HEADER)).not.toBeNull();
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('refuses another daemon’s scope, a malformed answer, and an answer for another prompt', async () => {
    const { calls, fetcher } = recorder(200, { requestId: 'fedcba9876543210', cleared: true });
    await expect(answerPermissionRequest(daemonA, scopeB, { kind: 'deny', requestId: ID }, fetcher)).rejects.toThrow(
      'permission scope must belong to the requested daemon',
    );
    await expect(
      answerPermissionRequest(daemonA, scopeA, { kind: 'deny', requestId: 'not-an-id' }, fetcher),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await expect(
      answerPermissionRequest(daemonA, scopeA, { kind: 'deny', requestId: ID }, fetcher),
    ).rejects.toMatchObject({
      status: 502,
      message: 'daemon answered another prompt',
    });
  });

  it('tells a prompt that is gone apart from every other refusal', async () => {
    const gone = recorder(409, { error: 'this prompt is gone', code: PERMISSION_PROMPT_GONE });
    const error = await answerPermissionRequest(daemonA, scopeA, { kind: 'deny', requestId: ID }, gone.fetcher).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(PermissionPromptGone);
    expect(error).toBeInstanceOf(DaemonResponseError);
    expect(error).toMatchObject({ status: 409, code: PERMISSION_PROMPT_GONE, message: 'this prompt is gone' });

    const failed = recorder(409, { error: 'could not type', code: 'console_input_failed' });
    const other = await answerPermissionRequest(daemonA, scopeA, { kind: 'deny', requestId: ID }, failed.fetcher).catch(
      (cause: unknown) => cause,
    );
    expect(other).not.toBeInstanceOf(PermissionPromptGone);
    expect(other).toMatchObject({ status: 409, code: 'console_input_failed', message: 'could not type' });

    const grant = recorder(403, { error: 'this device has no terminal grant', code: 'grant_refused' });
    await expect(
      answerPermissionRequest(daemonA, scopeA, { kind: 'deny', requestId: ID }, grant.fetcher),
    ).rejects.toMatchObject({ status: 403, code: 'grant_refused' });

    const opaque = recorder(500, 'not json');
    await expect(
      answerPermissionRequest(daemonA, scopeA, { kind: 'deny', requestId: ID }, opaque.fetcher),
    ).rejects.toMatchObject({ status: 500, message: 'HTTP 500', code: undefined });
  });
});

describe('the plain words for a permission request', () => {
  it('says each action as a person would', () => {
    const cases: readonly [Partial<PermissionRequest>, string][] = [
      [{}, 'Hadi wants to read /etc/hostname'],
      [
        { tool: 'Bash', action: 'run', what: 'curl -s https://example.com | head' },
        'Hadi wants to run `curl -s https://example.com | head`',
      ],
      [{ tool: 'Edit', action: 'edit', what: 'a.txt' }, 'Hadi wants to edit a.txt'],
      [{ tool: 'Write', action: 'create', what: 'new.txt' }, 'Hadi wants to create new.txt'],
      [
        { tool: 'WebFetch', action: 'fetch', what: 'https://example.com/docs' },
        'Hadi wants to fetch https://example.com/docs',
      ],
      [{ tool: 'deploy', action: 'use', what: 'deploy - release(…)' }, 'Hadi wants to use deploy - release(…)'],
      [{ tool: 'ExitPlanMode', action: 'exit-plan', what: undefined }, 'Hadi wants to exit plan mode and start'],
      [{ tool: 'Mystery', action: 'other', what: 'x' }, 'Hadi needs permission to use Mystery'],
    ];
    for (const [overrides, sentence] of cases) expect(permissionSentence('Hadi', request(overrides))).toBe(sentence);
  });

  it('names the kind of thing when the prompt names nothing', () => {
    const bare = (action: PermissionRequest['action'], tool = 'Tool') => {
      const { what: _what, ...rest } = request({ action, tool });
      return rest as PermissionRequest;
    };
    expect(permissionPhrase(bare('run'))).toBe('run a command');
    expect(permissionPhrase(bare('read'))).toBe('read a file');
    expect(permissionPhrase(bare('edit'))).toBe('edit a file');
    expect(permissionPhrase(bare('create'))).toBe('create a file');
    expect(permissionPhrase(bare('fetch'))).toBe('fetch a web page');
    expect(permissionPhrase(bare('use', 'mcp__deploy__release'))).toBe('use mcp__deploy__release');
    expect(permissionPhrase(bare('other', 'Mystery'))).toBe('use Mystery');
    expect(permissionWords('Hadi', bare('run'))).toEqual({ lead: 'Hadi wants to run a command' });
  });

  it('splits the sentence where the command or path begins, so it can be drawn in its own face', () => {
    expect(permissionWords('Hadi', request())).toEqual({ lead: 'Hadi wants to read', what: '/etc/hostname' });
    expect(permissionWords('Hadi', request({ tool: 'Bash', action: 'run', what: 'ls' }))).toEqual({
      lead: 'Hadi wants to run',
      what: 'ls',
    });
    expect(permissionWords('Hadi', request({ action: 'exit-plan' }))).toEqual({
      lead: 'Hadi wants to exit plan mode and start',
    });
    expect(permissionWords('Hadi', request({ tool: 'Mystery', action: 'other' }))).toEqual({
      lead: 'Hadi needs permission to use Mystery',
    });
  });

  it('shortens a path to its head and its file, and a command to its start', () => {
    expect(shortPath('/etc/hostname')).toBe('/etc/hostname');
    expect(shortPath('~/.ferretry/sessions/s1/turns/some/deeper/folder/turn-008.md')).toBe('~/…/turn-008.md');
    expect(shortPath('/home/kirin/Workspace/personal/ferretry/packages/pwa/src/lib/index.ts')).toBe('/home/…/index.ts');
    // Too few segments to elide, or a trailing slash: cut at the end instead.
    expect(shortPath(`/${'a'.repeat(60)}`, 20)).toBe(`/${'a'.repeat(18)}…`);
    expect(shortPath('/aaaaaaaaaa/bbbbbbbbbb/cccccccccc/', 20)).toBe('/aaaaaaaaaa/bbbbbbb…');
    expect(shortPath(`~/a/b/${'c'.repeat(40)}.md`, 20)).toBe(`~/…/${'c'.repeat(15)}…`);

    const long = `curl -s https://example.com/${'x'.repeat(80)}\n| head`;
    const shortened = shortPermissionWhat(request({ tool: 'Bash', action: 'run', what: long }));
    expect(shortened).toHaveLength(48);
    expect(shortened?.endsWith('…')).toBe(true);
    expect(shortPermissionWhat(request({ tool: 'Bash', action: 'run', what: 'ls\n  -la' }))).toBe('ls -la');
    expect(shortPermissionWhat(request({ what: '~/.ferretry/sessions/s1/turns/some/deeper/folder/turn-008.md' }))).toBe(
      '~/…/turn-008.md',
    );
    const { what: _what, ...noWhat } = request();
    expect(shortPermissionWhat(noWhat as PermissionRequest)).toBeUndefined();
  });

  it('labels each answer in the app’s words and keeps the harness’s', () => {
    const [allow, always, deny] = request().options;
    expect(permissionOptionWords(allow as never)).toEqual({ label: 'Allow once', harness: 'Yes' });
    expect(permissionOptionWords(always as never)).toEqual({
      label: 'Always allow',
      secondary: 'Yes, allow reading from /etc during this session',
      harness: 'Yes, allow reading from /etc during this session',
    });
    expect(permissionOptionWords(deny as never)).toEqual({ label: 'Deny', harness: 'No' });
  });
});
