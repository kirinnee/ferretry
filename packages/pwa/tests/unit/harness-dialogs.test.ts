import { describe, expect, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER, type HarnessDialog } from '@ferretry/protocol';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  answerHarnessDialog,
  HARNESS_DIALOG_GONE,
  HarnessDialogGone,
  harnessDialogHint,
  harnessDialogNotice,
  harnessDialogSentence,
  harnessTrustNote,
  harnessWord,
} from '../../src/lib/harness-dialogs.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'token-b' });
const scopeA = daemonSessionScope(daemonA, 'shared/session');
const scopeB = daemonSessionScope(daemonB, 'shared/session');
const ID = '0123456789abcdef';

const dialog = (overrides: Partial<HarnessDialog> = {}): HarnessDialog => ({
  id: ID,
  harness: 'codex',
  kind: 'hooks-review',
  title: 'Hooks need review',
  body: '1 hook is new or changed.',
  options: [
    { number: 1, label: 'Review hooks', grantsTrust: false },
    { number: 2, label: 'Trust all and continue', grantsTrust: true },
  ],
  selected: 1,
  escape: 'skip',
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

describe('answerHarnessDialog', () => {
  it('posts the answer to the session it belongs to and returns what the pane said', async () => {
    const { calls, fetcher } = recorder(200, { dialogId: ID, cleared: true });
    expect(await answerHarnessDialog(daemonA, scopeA, { kind: 'choice', dialogId: ID, number: 2 }, fetcher)).toEqual({
      dialogId: ID,
      cleared: true,
    });
    expect(calls[0]?.url).toBe('https://a.example.test/v1/sessions/shared%2Fsession/dialog');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ kind: 'choice', dialogId: ID, number: 2 });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get(FY_REQUEST_ID_HEADER)).not.toBeNull();
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('refuses another daemon’s scope, a malformed answer, and an answer for another dialog', async () => {
    const { calls, fetcher } = recorder(200, { dialogId: 'fedcba9876543210', cleared: true });
    await expect(answerHarnessDialog(daemonA, scopeB, { kind: 'escape', dialogId: ID }, fetcher)).rejects.toThrow(
      'dialog scope must belong to the requested daemon',
    );
    await expect(answerHarnessDialog(daemonA, scopeA, { kind: 'escape', dialogId: 'nope' }, fetcher)).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await expect(answerHarnessDialog(daemonA, scopeA, { kind: 'escape', dialogId: ID }, fetcher)).rejects.toMatchObject(
      {
        status: 502,
        message: 'daemon answered another dialog',
      },
    );
  });

  it('tells a dialog that is gone apart from every other refusal', async () => {
    const gone = recorder(409, { error: 'this dialog is gone', code: HARNESS_DIALOG_GONE });
    const error = await answerHarnessDialog(daemonA, scopeA, { kind: 'escape', dialogId: ID }, gone.fetcher).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(HarnessDialogGone);
    expect(error).toBeInstanceOf(DaemonResponseError);
    expect(error).toMatchObject({ status: 409, code: HARNESS_DIALOG_GONE, message: 'this dialog is gone' });

    const invalid = recorder(400, { error: 'no such choice', code: 'invalid_dialog_choice' });
    const other = await answerHarnessDialog(daemonA, scopeA, { kind: 'escape', dialogId: ID }, invalid.fetcher).catch(
      (cause: unknown) => cause,
    );
    expect(other).not.toBeInstanceOf(HarnessDialogGone);
    expect(other).toMatchObject({ status: 400, code: 'invalid_dialog_choice', message: 'no such choice' });

    const opaque = recorder(500, 'not json');
    await expect(
      answerHarnessDialog(daemonA, scopeA, { kind: 'escape', dialogId: ID }, opaque.fetcher),
    ).rejects.toMatchObject({ status: 500, message: 'HTTP 500', code: undefined });
  });
});

describe('the plain words for a harness dialog', () => {
  it('names the harness as a person does', () => {
    expect(harnessWord('codex')).toBe('Codex');
    expect(harnessWord('claude')).toBe('Claude Code');
  });

  it('says the dialog as a card heading and as a notification', () => {
    expect(harnessDialogSentence('Hadi', dialog())).toBe('Hadi’s Codex is waiting: Hooks need review');
    expect(harnessDialogNotice('Hadi', dialog())).toBe('Hadi is waiting on Codex: Hooks need review');
    expect(harnessDialogNotice('Hadi', dialog({ harness: 'claude', title: 'New MCP server found' }))).toBe(
      'Hadi is waiting on Claude Code: New MCP server found',
    );
  });

  it('says what trusting grants, per kind', () => {
    expect(harnessTrustNote(dialog())).toBe('Trusts these to run outside the sandbox');
    expect(harnessTrustNote(dialog({ kind: 'mcp-servers' }))).toBe('Lets this MCP server run');
    expect(harnessTrustNote(dialog({ kind: 'directory-trust' }))).toBe('Grants trust');
  });

  it('hints only where the card cannot finish the job', () => {
    expect(harnessDialogHint(dialog({ kind: 'sign-in' }))).toBe('Signing in finishes in the Console.');
    expect(harnessDialogHint(dialog())).toBeUndefined();
  });
});
