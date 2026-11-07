import { describe, expect, test } from 'bun:test';
import type { HarnessDialog, PermissionRequest } from '../../../contract/index.ts';
import {
  HARNESS_DIALOG_GONE,
  HarnessDialogGone,
  answerHarnessDialog,
  harnessDialogSentence,
  harnessTrustNote,
} from '../../../app/lib/harness-dialogs.ts';
import {
  PERMISSION_PROMPT_GONE,
  PermissionPromptGone,
  answerPermissionRequest,
  permissionOptionWords,
  permissionPhrase,
  permissionWords,
  shortPath,
  shortPermissionWhat,
} from '../../../app/lib/permission-requests.ts';

const ID = '0123456789abcdef';

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const client = (answer: unknown | Error) => {
  const calls: { route: string; init: unknown }[] = [];
  return {
    calls,
    call: async (route: string, init?: unknown) => {
      calls.push({ route, init });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as never;
};

const request = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: ID,
  harness: 'claude-code',
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

describe('answering a permission prompt from the app', () => {
  test('G31 the answer is the one POST for that ferret and carries only the request id and the choice', async () => {
    const fake = client({ requestId: ID, cleared: true });

    const result = await answerPermissionRequest(fake, 'f1', { kind: 'choice', requestId: ID, number: 2 });

    expect(result).toEqual({ requestId: ID, cleared: true });
    expect((fake as unknown as { calls: unknown[] }).calls).toEqual([
      {
        route: 'POST /v1/ferrets/:ferretId/permission',
        init: { params: { ferretId: 'f1' }, body: { kind: 'choice', requestId: ID, number: 2 } },
      },
    ]);
  });

  test('G31 a prompt the pane no longer shows becomes PermissionPromptGone, not a generic failure', async () => {
    const gone = client(new Refused(409, PERMISSION_PROMPT_GONE, 'that prompt is gone'));

    await expect(answerPermissionRequest(gone, 'f1', { kind: 'deny', requestId: ID })).rejects.toBeInstanceOf(
      PermissionPromptGone,
    );
  });

  test('G31 another refusal passes through untouched', async () => {
    const refused = new Refused(403, 'grant_refused', 'no');

    await expect(answerPermissionRequest(client(refused), 'f1', { kind: 'deny', requestId: ID })).rejects.toBe(refused);
  });

  test('G31 an answer for another prompt is never believed', async () => {
    const other = client({ requestId: 'ffffffffffffffff', cleared: true });

    await expect(answerPermissionRequest(other, 'f1', { kind: 'deny', requestId: ID })).rejects.toThrow(
      'another prompt',
    );
  });

  test('G31 a choice number outside the body schema is refused before anything is sent', async () => {
    const fake = client({});

    await expect(answerPermissionRequest(fake, 'f1', { kind: 'choice', requestId: ID, number: 0 })).rejects.toThrow();
    expect((fake as unknown as { calls: unknown[] }).calls).toEqual([]);
  });
});

describe('answering a harness dialog from the app', () => {
  test('G32 the answer is the one POST for that ferret', async () => {
    const fake = client({ dialogId: ID, cleared: false });

    const result = await answerHarnessDialog(fake, 'f1', { kind: 'escape', dialogId: ID });

    expect(result.cleared).toBe(false);
    expect((fake as unknown as { calls: { route: string }[] }).calls[0]?.route).toBe(
      'POST /v1/ferrets/:ferretId/dialog',
    );
  });

  test('G32 a dialog that is gone becomes HarnessDialogGone', async () => {
    const gone = client(new Refused(409, HARNESS_DIALOG_GONE, 'gone'));

    await expect(answerHarnessDialog(gone, 'f1', { kind: 'escape', dialogId: ID })).rejects.toBeInstanceOf(
      HarnessDialogGone,
    );
  });

  test('G32 the words name Claude Code and the trust a row grants', () => {
    const dialog = {
      id: ID,
      harness: 'claude-code',
      kind: 'mcp-servers',
      title: 'New MCP server found',
      options: [],
      escape: 'skip',
    } as HarnessDialog;

    expect(harnessDialogSentence('Hadi', dialog)).toBe('Hadi’s Claude Code is waiting: New MCP server found');
    expect(harnessTrustNote(dialog)).toBe('Lets this MCP server run');
  });
});

describe('the plain words for a permission prompt', () => {
  test('a long path keeps its head and its file', () => {
    expect(shortPath('/home/someone/projects/ferretry/packages/app/turn-008.md', 30)).toBe('/home/…/turn-008.md');
  });

  test('a request is a sentence about the ferret', () => {
    expect(permissionWords('Hadi', request())).toEqual({ lead: 'Hadi wants to read', what: '/etc/hostname' });
    expect(permissionPhrase(request({ action: 'exit-plan', what: undefined }))).toBe('exit plan mode and start');
    expect(shortPermissionWhat(request({ action: 'run', what: 'curl   -s\nhttps://example.com' }))).toBe(
      'curl -s https://example.com',
    );
  });

  test('buttons say what they do and keep the harness label', () => {
    expect(
      request()
        .options.map(permissionOptionWords)
        .map(option => option.label),
    ).toEqual(['Allow once', 'Always allow', 'Deny']);
  });
});
