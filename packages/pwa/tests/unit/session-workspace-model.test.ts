import { describe, expect, test } from 'bun:test';
import { turnFileInstruction } from '@ferretry/protocol';
import {
  ACTED_WATCH_MS,
  NUDGE_SETTLE_MS,
  RELAXED_REFRESH_MS,
  type SessionWorkspaceRefreshEnvironment,
  sendCanceller,
  sendRetrier,
  sendSubmitter,
  startSessionWorkspaceRefresh,
  transcriptEntriesFromLog,
} from '../../src/components/session-workspace-model.ts';
import { sessionView } from '../support/sessions.ts';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

describe('transcriptEntriesFromLog', () => {
  test('projects normalized user and assistant messages with multiline Markdown intact', () => {
    const entries = transcriptEntriesFromLog(
      '[10:11:12] user/message: Please ship it\n[10:11:13] assistant/message: ## Done\n    - built\n    - tested',
      NOW,
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'user',
      label: 'You',
      at: Date.UTC(2026, 9, 18, 10, 11, 12),
      text: 'Please ship it',
    });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      label: 'Assistant',
      at: Date.UTC(2026, 9, 18, 10, 11, 13),
      text: '## Done\n- built\n- tested',
    });
    expect(entries[0]?.id).not.toBe(entries[1]?.id);
  });

  test("reads the daemon's turn pointer as a hand-off on the person's own row, for Claude and Codex alike", () => {
    const claude = turnFileInstruction('/home/kirin/.ferretry/state/sessions/s1/turns/turn-008.md');
    const codex = turnFileInstruction('/Users/erng/.ferretry/state/sessions/s2/turns/turn-002.md');
    const entries = transcriptEntriesFromLog(
      `[10:11:12] user/message: ${claude}\n[10:11:13] assistant/message: on it\n[10:12:00] user/message: ${codex}`,
      NOW,
    );

    expect(entries.map(entry => [entry.kind, entry.handoff?.name])).toEqual([
      ['user', 'turn-008'],
      ['assistant', undefined],
      ['user', 'turn-002'],
    ]);
    // The pointer is kept as the row's text only so a row whose file is gone can show it faded.
    expect(entries[0]?.text).toBe(claude);
    expect(entries[0]?.label).toBe('You');
  });

  test('keeps the daemon’s UTC wall clock out of every label — the time is an instant, formatted by the reader', () => {
    const entries = transcriptEntriesFromLog('[01:45:44] user/message: hi\n[01:47:02] assistant/message: hello', NOW);
    expect(entries.map(entry => entry.label)).toEqual(['You', 'Assistant']);
    expect(entries.map(entry => entry.at)).toEqual([Date.UTC(2026, 9, 18, 1, 45, 44), Date.UTC(2026, 9, 18, 1, 47, 2)]);
  });

  test('dates a transcript that crosses midnight by walking back from the newest record', () => {
    const entries = transcriptEntriesFromLog(
      [
        '[23:58:00] user/message: before midnight',
        'assistant/message: no clock of its own',
        '[00:01:00] assistant/message: after midnight',
      ].join('\n'),
      NOW,
    );
    expect(entries.map(entry => entry.at)).toEqual([
      Date.UTC(2026, 9, 17, 23, 58, 0),
      undefined,
      Date.UTC(2026, 9, 18, 0, 1, 0),
    ]);
    expect(entries[1]).not.toHaveProperty('at');
  });

  test('leaves every bookkeeping record out of the conversation entirely', () => {
    const entries = transcriptEntriesFromLog(
      [
        'assistant/reasoning: check the tree',
        'tool/tool-call: Read({"path":"src/App.tsx"})',
        'tool/tool-result: output',
        'developer/settings: {"model":"opus"}',
        'system/turn: completed',
      ].join('\n'),
    );

    expect(entries.map(entry => [entry.kind, entry.label, entry.text])).toEqual([['tool', undefined, 'ran a tool']]);
    expect(entries[0]?.tools).toEqual([
      {
        key: expect.stringMatching(/^log:1:/u) as unknown as string,
        use: { name: 'Read', input: { path: 'src/App.tsx' } },
        result: { text: 'output' },
      },
    ]);
  });

  test('keeps a tool run whole across the usage and turn records Claude writes between call and result', () => {
    const entries = transcriptEntriesFromLog(
      [
        'assistant/message: Checking.',
        'assistant/tool-call: Bash({"command":"git status"})',
        'assistant/usage: in=1 out=2',
        'assistant/tool-call: Edit({"file_path":"a.ts"})',
        'assistant/usage: in=1 out=2',
        'tool/tool-result: clean',
        'system/turn: started',
        'tool/tool-result: applied',
        'assistant/message: Done.',
      ].join('\n'),
    );
    expect(entries.map(entry => [entry.kind, entry.text])).toEqual([
      ['assistant', 'Checking.'],
      ['tool', 'ran 2 tools'],
      ['assistant', 'Done.'],
    ]);
    expect(entries[1]?.tools?.map(call => [call.use.name, call.result?.text, call.orphanResult])).toEqual([
      ['Bash', 'clean', undefined],
      ['Edit', 'applied', undefined],
    ]);
  });

  test('dates a tool call from its wall clock so a running tool can show how long it has run', () => {
    const now = Date.parse('2026-10-16T10:00:41.000Z');
    const [today] = transcriptEntriesFromLog('[10:00:00] assistant/tool-call: Bash({"command":"bun test"})', now);
    expect(today?.tools?.[0]?.ts).toBe('2026-10-16T10:00:00.000Z');
    // A clock later than now is yesterday's: the call started before midnight.
    const [yesterday] = transcriptEntriesFromLog('[23:59:50] assistant/tool-call: Bash({})', now);
    expect(yesterday?.tools?.[0]?.ts).toBe('2026-10-15T23:59:50.000Z');
    // No clock, no invented instant.
    expect(transcriptEntriesFromLog('assistant/tool-call: Bash({})', now)[0]?.tools?.[0]).not.toHaveProperty('ts');
  });

  test('reads a Claude slash command as one command row, never a "You" bubble, and drops the caveat', () => {
    const entries = transcriptEntriesFromLog(
      [
        '[10:00:00] user/message: <local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages.</local-command-caveat>',
        '[10:00:00] user/message: <command-name>/model</command-name>',
        '    <command-message>model</command-message>',
        '    <command-args>opus[1m]</command-args>',
        '[10:00:01] user/message: <local-command-stdout>Set model to \u001b[1mOpus 5.5 (1M context)\u001b[22m</local-command-stdout>',
        '[10:00:02] user/message: Thanks — now continue.',
      ].join('\n'),
    );
    expect(entries.map(entry => entry.kind)).toEqual(['command', 'user']);
    expect(entries[0]?.command).toEqual({
      name: '/model',
      args: 'opus[1m]',
      output: 'Set model to Opus 5.5 (1M context)',
      tone: 'ok',
    });
    expect(entries[0]?.text).toBe('/model opus[1m] Set model to Opus 5.5 (1M context)');
    expect(JSON.stringify(entries)).not.toContain('Caveat');
  });

  test('keeps a stderr result in the error tone and output whose command scrolled away on its own row', () => {
    const entries = transcriptEntriesFromLog(
      [
        'user/message: <local-command-stdout>orphaned output</local-command-stdout>',
        'user/message: <command-name>/doctor</command-name>',
        'user/message: <local-command-stderr>config unreadable</local-command-stderr>',
        'user/message: <command-name>/clear</command-name>',
        'user/message: <command-name>/cost</command-name>',
        'user/message: <local-command-stdout></local-command-stdout>',
      ].join('\n'),
    );
    expect(entries.map(entry => entry.command)).toEqual([
      { name: '', output: 'orphaned output', tone: 'ok' },
      { name: '/doctor', output: 'config unreadable', tone: 'err' },
      { name: '/clear', tone: 'ok' },
      { name: '/cost', tone: 'ok' },
    ]);
  });

  test('a command ends a tool run, and a caveat does not', () => {
    const entries = transcriptEntriesFromLog(
      [
        'assistant/tool-call: Read({})',
        'user/message: <local-command-caveat>Caveat</local-command-caveat>',
        'tool/tool-result: read',
        'user/message: <command-name>/model</command-name>',
        'assistant/tool-call: Bash({})',
      ].join('\n'),
    );
    expect(entries.map(entry => entry.kind)).toEqual(['tool', 'command', 'tool']);
    expect(entries[0]?.tools?.[0]?.result).toEqual({ text: 'read' });
  });

  test('folds a run of tool calls into one row and pairs each result with the oldest waiting call', () => {
    const entries = transcriptEntriesFromLog(
      [
        'assistant/tool-call: Bash({"command":"git status"})',
        'assistant/tool-call: Edit(not json)',
        'tool/tool-result: clean',
        'tool/tool-result: error refused',
        'tool/tool-result: stray',
        'assistant/tool-call: (',
        'assistant/error: E1: broke',
        'assistant/tool-call: Read({})',
      ].join('\n'),
    );
    expect(entries.map(entry => [entry.kind, entry.text, entry.alert])).toEqual([
      ['tool', 'ran 4 tools', undefined],
      ['notice', 'E1: broke', true],
      ['tool', 'ran a tool', undefined],
    ]);
    const calls = entries[0]?.tools ?? [];
    expect(calls.map(call => [call.use, call.result, call.orphanResult])).toEqual([
      [{ name: 'Bash', input: { command: 'git status' } }, { text: 'clean' }, undefined],
      [{ name: 'Edit', input: 'not json' }, { text: 'refused', isError: true }, undefined],
      [{ name: 'result' }, { text: 'stray' }, true],
      [{ name: '(' }, undefined, undefined],
    ]);
    expect(entries[2]?.tools?.[0]?.use).toEqual({ name: 'Read', input: {} });
  });

  test('labels an error by who raised it, because an error is never hidden', () => {
    const entries = transcriptEntriesFromLog(
      ['[09:00:00] tool/error: E2: gone', 'system/error: E3: lost', 'system/turn: started'].join('\n'),
    );
    expect(entries.map(entry => [entry.kind, entry.label, entry.alert])).toEqual([
      ['notice', 'Tool · Error', true],
      ['notice', 'System', true],
    ]);
  });

  test('names an empty tool call rather than inventing one', () => {
    expect(transcriptEntriesFromLog('assistant/tool-call: ')[0]?.tools?.[0]?.use).toEqual({ name: 'tool' });
  });

  test('leaves text before the first record out and keeps non-indented continuation text', () => {
    const entries = transcriptEntriesFromLog('unparsed evidence\r\nassistant/message: hello\r\ncontinuation');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'assistant', text: 'hello\ncontinuation' });
  });

  test('returns no invented row for a proved empty transcript and labels an empty normalized body', () => {
    expect(transcriptEntriesFromLog(' \n')).toEqual([]);
    expect(transcriptEntriesFromLog('assistant/message: ')[0]).toMatchObject({ text: 'Message', label: 'Assistant' });
  });

  test('uses content-stable identities', () => {
    const text = 'assistant/message: same';
    expect(transcriptEntriesFromLog(text)[0]?.id).toBe(transcriptEntriesFromLog(text)[0]?.id);
    expect(transcriptEntriesFromLog('assistant/message: different')[0]?.id).not.toBe(
      transcriptEntriesFromLog(text)[0]?.id,
    );
  });
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const environment = (initiallyVisible = true) => {
  let visible = initiallyVisible;
  let interval: (() => void) | undefined;
  let visibility: (() => void) | undefined;
  const cleared: unknown[] = [];
  let unsubscribed = false;
  const env: SessionWorkspaceRefreshEnvironment = {
    visible: () => visible,
    setInterval: (callback, milliseconds) => {
      interval = callback;
      return `timer:${milliseconds}`;
    },
    clearInterval: handle => cleared.push(handle),
    onVisibility: callback => {
      visibility = callback;
      return () => {
        unsubscribed = true;
      };
    },
  };
  return {
    env,
    tick: () => interval?.(),
    show: () => {
      visible = true;
      visibility?.();
    },
    cleared,
    unsubscribed: () => unsubscribed,
  };
};

describe('startSessionWorkspaceRefresh', () => {
  test('hands the raw log text to onLog on a good read, and nothing when the read fails', async () => {
    const browser = environment();
    const logs: string[] = [];
    let fail = false;
    const control = startSessionWorkspaceRefresh({
      api: {
        logs: async () => {
          if (fail) throw new Error('offline');
          return 'assistant/message: hello';
        },
        get: async () => sessionView('s-1'),
      },
      sessionId: 's-1',
      environment: browser.env,
      onTranscript: () => undefined,
      onLog: text => logs.push(text),
      onSession: () => undefined,
      onError: () => undefined,
    });

    await control.initial;
    fail = true;
    await control.refresh();
    control.stop();

    expect(logs).toEqual(['assistant/message: hello']);
  });
  test('reads the send ledger beside the transcript, keeping the last rows when that read fails', async () => {
    const browser = environment();
    const sends: unknown[] = [];
    const failures: string[] = [];
    let fail = false;
    const row = {
      v: 1 as const,
      sendId: 'send-1',
      acceptedAt: '2026-07-31T10:00:00.000Z',
      acceptedTurn: 1,
      path: 'direct' as const,
      message: 'hi',
      attachmentIds: [],
      fate: 'queued' as const,
    };
    const control = startSessionWorkspaceRefresh({
      api: {
        logs: async () => '',
        get: async () => sessionView('s-1'),
        sends: async () => {
          if (fail) throw new Error('older daemon');
          return [row];
        },
      },
      sessionId: 's-1',
      environment: browser.env,
      onTranscript: () => undefined,
      onSession: () => undefined,
      onSends: rows => sends.push(rows),
      onSendsFailed: reason => failures.push(reason),
      onError: () => undefined,
    });

    await control.initial;
    fail = true;
    await control.refresh();
    control.stop();

    expect(sends).toEqual([[row]]);
    // Said, not swallowed: the rows left on screen are about to claim a fate nobody is reading.
    expect(failures).toEqual(['older daemon']);
  });
  test('says when the daemon can prove no transcript is this session’s, apart from other failures', async () => {
    const browser = environment();
    const unbound: boolean[] = [];
    let failure: unknown = Object.assign(new Error('session s-1 has no transcript this daemon can prove is its own'), {
      code: 'no_transcript',
    });
    const control = startSessionWorkspaceRefresh({
      api: {
        logs: async () => {
          if (failure !== undefined) throw failure;
          return 'assistant/message: hello';
        },
        get: async () => sessionView('s-1'),
      },
      sessionId: 's-1',
      environment: browser.env,
      onTranscript: () => undefined,
      onSession: () => undefined,
      onError: () => undefined,
      onTranscriptUnbound: value => unbound.push(value),
      quiet: reason => reason === 'outage',
    });

    await control.initial;
    failure = new Error('the file vanished');
    await control.refresh();
    failure = 'outage';
    await control.refresh();
    failure = undefined;
    await control.refresh();
    control.stop();

    // An outage said elsewhere neither sets nor clears it.
    expect(unbound).toEqual([true, false, false]);
  });

  test('loads transcript and session immediately, then clears a previous error', async () => {
    const browser = environment();
    const transcript: unknown[] = [];
    const sessions: unknown[] = [];
    const errors: Array<string | null> = [];
    const control = startSessionWorkspaceRefresh({
      api: {
        logs: async () => 'assistant/message: hello',
        get: async () => sessionView('s-1'),
      },
      sessionId: 's-1',
      intervalMs: 500,
      environment: browser.env,
      onTranscript: entries => transcript.push(entries),
      onSession: view => sessions.push(view),
      onError: message => errors.push(message),
    });

    await control.initial;
    expect(transcript).toHaveLength(1);
    expect(sessions).toHaveLength(1);
    expect(errors).toEqual([null]);
    control.stop();
    expect(browser.cleared).toEqual(['timer:1000']);
    expect(browser.unsubscribed()).toBe(true);
    control.stop();
  });

  test('sleeps while hidden and refreshes as soon as visibility returns', async () => {
    const browser = environment(false);
    let reads = 0;
    const control = startSessionWorkspaceRefresh({
      api: {
        logs: async () => {
          reads++;
          return '';
        },
        get: async () => sessionView('s-1'),
      },
      sessionId: 's-1',
      environment: browser.env,
      onTranscript: () => undefined,
      onSession: () => undefined,
      onError: () => undefined,
    });

    await control.initial;
    browser.tick();
    expect(reads).toBe(0);
    browser.show();
    await control.refresh();
    expect(reads).toBe(1);
    control.stop();
  });

  test('coalesces overlapping interval and manual refreshes', async () => {
    const browser = environment();
    const logs = deferred<string>();
    let reads = 0;
    const control = startSessionWorkspaceRefresh({
      api: {
        logs: async () => {
          reads++;
          return await logs.promise;
        },
        get: async () => sessionView('s-1'),
      },
      sessionId: 's-1',
      environment: browser.env,
      onTranscript: () => undefined,
      onSession: () => undefined,
      onError: () => undefined,
    });

    browser.tick();
    const same = control.refresh();
    expect(reads).toBe(1);
    logs.resolve('');
    await Promise.all([control.initial, same]);
    expect(reads).toBe(1);
    control.stop();
  });

  test('queues one fresh read after an older poll when a write asks for current evidence', async () => {
    const browser = environment();
    const first = deferred<string>();
    const transcripts: string[] = [];
    let reads = 0;
    const control = startSessionWorkspaceRefresh({
      api: {
        logs: async () => {
          reads++;
          return reads === 1 ? await first.promise : 'assistant/message: after write';
        },
        get: async () => sessionView('s-1'),
      },
      sessionId: 's-1',
      environment: browser.env,
      onTranscript: entries => transcripts.push(entries.at(-1)?.text ?? ''),
      onSession: () => undefined,
      onError: () => undefined,
    });

    const afterWrite = control.refresh(true);
    expect(reads).toBe(1);
    first.resolve('assistant/message: before write');
    await afterWrite;

    expect(reads).toBe(2);
    expect(transcripts).toEqual(['before write', 'after write']);
    control.stop();
  });

  test('reports transcript and session failures independently', async () => {
    const browser = environment();
    const transcripts: unknown[] = [];
    const sessions: unknown[] = [];
    const errors: Array<string | null> = [];
    const first = startSessionWorkspaceRefresh({
      api: {
        logs: async () => {
          throw new Error('unreadable');
        },
        get: async () => sessionView('other'),
      },
      sessionId: 's-1',
      environment: browser.env,
      onTranscript: entries => transcripts.push(entries),
      onSession: view => sessions.push(view),
      onError: message => errors.push(message),
    });
    await first.initial;
    first.stop();

    expect(transcripts).toEqual([]);
    expect(sessions).toEqual([]);
    expect(errors).toEqual(['Transcript: unreadable · Session: daemon returned another session']);

    const second = startSessionWorkspaceRefresh({
      api: {
        logs: async () => 'assistant/message: retained',
        get: async () => await Promise.reject('offline'),
      },
      sessionId: 's-1',
      environment: browser.env,
      onTranscript: entries => transcripts.push(entries),
      onSession: view => sessions.push(view),
      onError: message => errors.push(message),
    });
    await second.initial;
    second.stop();

    expect(transcripts).toHaveLength(1);
    expect(errors.at(-1)).toBe('Session: offline');
  });

  test('keeps the last good transcript and the message through a failure somebody else says', async () => {
    // Arrange — a carrier outage, which the connection model reports once; and a daemon answer, which
    // is still this screen's to say.
    const browser = environment();
    const outage = new Error('no carrier');
    const errors: (string | null)[] = [];
    const transcripts: unknown[] = [];
    let logs: () => Promise<string> = async () => 'assistant/message: kept';
    let get: () => Promise<ReturnType<typeof sessionView>> = async () => sessionView('s-1');
    const control = startSessionWorkspaceRefresh({
      api: { logs: async () => await logs(), get: async () => await get() },
      sessionId: 's-1',
      environment: browser.env,
      onTranscript: entries => transcripts.push(entries),
      onSession: () => undefined,
      onError: message => errors.push(message),
      quiet: reason => reason === outage,
    });
    await control.initial;
    expect(errors).toEqual([null]);

    // Act I — both reads fail with the outage: nothing is said and nothing is cleared.
    logs = async () => await Promise.reject(outage);
    get = async () => await Promise.reject(outage);
    await control.refresh();
    expect(errors).toEqual([null]);
    expect(transcripts).toHaveLength(1);

    // Act II — one quiet failure beside a loud one: only the loud one is said.
    get = async () => await Promise.reject(new Error('session read refused'));
    await control.refresh();
    control.stop();
    expect(errors.at(-1)).toBe('Session: session read refused');
  });

  test('drops a late answer after teardown', async () => {
    const browser = environment();
    const logs = deferred<string>();
    const session = deferred<ReturnType<typeof sessionView>>();
    const painted: unknown[] = [];
    const control = startSessionWorkspaceRefresh({
      api: { logs: async () => await logs.promise, get: async () => await session.promise },
      sessionId: 's-1',
      environment: browser.env,
      onTranscript: entries => painted.push(entries),
      onSession: view => painted.push(view),
      onError: message => painted.push(message),
    });

    control.stop();
    logs.resolve('assistant/message: too late');
    session.resolve(sessionView('s-1'));
    await control.initial;
    await control.refresh();
    expect(painted).toEqual([]);
  });
});

describe('sendRetrier', () => {
  test('re-sends under the original id and refreshes, and does nothing without a client', async () => {
    const calls: unknown[] = [];
    let refreshed = 0;
    const retry = sendRetrier(
      { retrySend: async (...args) => void calls.push(args) as never },
      's-1',
      () => (refreshed += 1),
    );

    expect(await retry({ sendId: 'send-1' }, true)).toBe(true);
    expect(await sendRetrier(null, 's-1', () => (refreshed += 1))({ sendId: 'send-1' }, false)).toBe(false);
    expect(calls).toEqual([['s-1', 'send-1', true]]);
    expect(refreshed).toBe(1);
  });
});

describe('transcriptEntriesFromLog · who a user record is from', () => {
  /** Aniya's transcript as the daemon renders it: the paste block Claude wrapped the peer send in. */
  const peerLog = [
    '[10:01:02] user/message: <pasted_content id="1fd4">',
    '    [peer message from teammate torrey (session mvb0sw7d-27f71326) — not from the human lead]',
    '    No reply is required; torrey has carried on. Reply with `fy send torrey "…"` if useful.',
    '    ',
    "    Hey! How's your day going?",
    '    </pasted_content id="1fd4">',
  ].join('\n');

  test("renders another agent's message as FROM that agent, never as You", () => {
    const [entry] = transcriptEntriesFromLog(peerLog, NOW);
    expect(entry).toMatchObject({
      kind: 'user',
      text: "Hey! How's your day going?",
      at: Date.UTC(2026, 9, 18, 10, 1, 2),
      peer: { name: 'torrey', sessionId: 'mvb0sw7d-27f71326', replyExpected: false },
    });
  });

  test('keeps the id the record would have had, whatever it was read as', () => {
    const [peer] = transcriptEntriesFromLog(peerLog, NOW);
    const [plain] = transcriptEntriesFromLog(peerLog.replace('[10:01:02] ', ''), NOW);
    expect(peer?.id).toMatch(/^log:0:/);
    expect(plain).not.toHaveProperty('at');
    expect(plain?.peer?.name).toBe('torrey');
  });

  test("renders Ferretry's own notice as a system row", () => {
    const entries = transcriptEntriesFromLog(
      [
        '[10:05:00] user/message: [ferretry] Your message to aniya (send s-1) did not reach it.',
        'user/message: [ferretry] A notice with no clock.',
      ].join('\n'),
      NOW,
    );
    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'system',
        text: 'Your message to aniya (send s-1) did not reach it.',
        at: Date.UTC(2026, 9, 18, 10, 5, 0),
      }),
      expect.objectContaining({ kind: 'system', text: 'A notice with no clock.' }),
    ]);
    expect(entries[1]).not.toHaveProperty('at');
  });

  test("renders the harness's own background-task event as a system row, never as You", () => {
    // The daemon's rendering of a real Claude Code record: the body indented under its header.
    const entries = transcriptEntriesFromLog(
      [
        '[10:07:00] user/message: <task-notification>',
        '    <task-id>bdwjs9ydf</task-id>',
        '    <output-file>/tmp/claude-1000/project/session/tasks/bdwjs9ydf.output</output-file>',
        '    <status>completed</status>',
        '    <summary>Background command "bun test &amp;&amp; echo ok" completed (exit code 0)</summary>',
        '    </task-notification>',
        '[10:07:01] user/message: [Request interrupted by user]',
        'user/message: thanks, that works',
      ].join('\n'),
      NOW,
    );
    expect(entries.map(entry => entry.kind)).toEqual(['system', 'system', 'user']);
    expect(entries[0]).toMatchObject({
      kind: 'system',
      text: 'Background command "bun test && echo ok" completed (exit code 0)',
      at: Date.UTC(2026, 9, 18, 10, 7, 0),
      event: {
        label: 'task notification',
        tasks: [{ kind: 'command', outcome: 'finished', subject: 'bun test && echo ok', exitCode: 0 }],
      },
    });
    expect(entries[0]).not.toHaveProperty('label');
    expect(entries[1]).toMatchObject({ kind: 'system', event: { label: 'interrupted' } });
    expect(entries[2]).toMatchObject({ kind: 'user', label: 'You', text: 'thanks, that works' });
    expect(entries[2]).not.toHaveProperty('event');
  });

  test('a harness event with no summary reads as its label and keeps no clock it was not given', () => {
    const [entry] = transcriptEntriesFromLog('user/message: <task-notification>\n    </task-notification>', NOW);
    expect(entry).toMatchObject({ kind: 'system', text: 'task notification' });
    expect(entry).not.toHaveProperty('at');
  });

  test("shows a person's own paste without its markup, still as You", () => {
    const [entry] = transcriptEntriesFromLog(
      '[10:06:00] user/message: <pasted_content id="aa">\n    first line\n    second line\n    </pasted_content>',
      NOW,
    );
    expect(entry).toMatchObject({ kind: 'user', label: 'You', text: 'first line\nsecond line' });
    expect(entry).not.toHaveProperty('peer');
  });
});

describe('transcriptEntriesFromLog · messages between ferrets', () => {
  const turn = '/home/kirin/.ferretry/state/sessions/tanna/turns/turn-001.md';
  const pointer = turnFileInstruction(turn);

  test('a Claude receiver: the hand-off row stays and its own Read of the turn file is gone', () => {
    const entries = transcriptEntriesFromLog(
      [
        `[10:00:00] user/message: ${pointer}`,
        `[10:00:01] assistant/tool-call: Read(${JSON.stringify({ file_path: turn })})`,
        '[10:00:01] tool/tool-result: [message from ferret tomi (session mveq0r0r-ddd75d7b) — not from the owner]',
        '[10:00:05] assistant/message: Hi tomi!',
      ].join('\n'),
      NOW,
    );
    expect(entries.map(entry => entry.kind)).toEqual(['user', 'assistant']);
    expect(entries[0]?.handoff?.name).toBe('turn-001');
  });

  test('a Codex receiver: its cat of the turn file is gone, and a FAILED read stays', () => {
    const read = `[10:00:01] assistant/tool-call: exec_command(${JSON.stringify({ cmd: `cat ${turn}` })})`;
    const ok = transcriptEntriesFromLog(
      [`[10:00:00] user/message: ${pointer}`, read, '[10:00:01] tool/tool-result: Process exited with code 0'].join(
        '\n',
      ),
      NOW,
    );
    expect(ok.map(entry => entry.kind)).toEqual(['user']);
    const failed = transcriptEntriesFromLog(
      [`[10:00:00] user/message: ${pointer}`, read, '[10:00:01] tool/tool-result: error No such file'].join('\n'),
      NOW,
    );
    expect(failed.map(entry => entry.kind)).toEqual(['user', 'tool']);
  });

  test('a Claude sender: its fy send is a "sent" row, not a tool group', () => {
    const entries = transcriptEntriesFromLog(
      [
        `[10:00:00] assistant/tool-call: Bash(${JSON.stringify({ command: 'fy send tanna "Hello from home-manager-fd"' })})`,
        '[10:00:01] tool/tool-result: delivered',
      ].join('\n'),
      NOW,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sent).toEqual({
      to: 'tanna',
      body: 'Hello from home-manager-fd',
      ask: false,
      state: 'delivered',
    });
  });

  test('a Codex sender, under a renamed binary', () => {
    const entries = transcriptEntriesFromLog(
      [
        `[10:00:00] assistant/tool-call: exec_command(${JSON.stringify({ cmd: "ferret send tanna 'are you free?' --ask" })})`,
        '[10:00:01] tool/tool-result: Process exited with code 0\nOutput:\nqueued in the agent’s own queue',
      ].join('\n'),
      NOW,
      'ferret',
    );
    expect(entries[0]?.sent).toMatchObject({ to: 'tanna', body: 'are you free?', ask: true, state: 'queued' });
  });
});

describe('sendCanceller and sendSubmitter', () => {
  test('cancel the send, or press Enter for it, by its id and refresh; nothing happens without a client', async () => {
    const calls: unknown[] = [];
    let refreshed = 0;
    const client = {
      cancelSend: async (...args: unknown[]) => void calls.push(['cancel', ...args]) as never,
      submitSend: async (...args: unknown[]) => void calls.push(['enter', ...args]) as never,
    };

    expect(await sendCanceller(client, 's-1', () => (refreshed += 1))({ sendId: 'send-1' })).toBe(true);
    expect(await sendSubmitter(client, 's-1', () => (refreshed += 1))({ sendId: 'send-2' })).toBe(true);
    expect(await sendCanceller(null, 's-1', () => (refreshed += 1))({ sendId: 'send-1' })).toBe(false);
    expect(await sendSubmitter(null, 's-1', () => (refreshed += 1))({ sendId: 'send-1' })).toBe(false);
    expect(calls).toEqual([
      ['cancel', 's-1', 'send-1'],
      ['enter', 's-1', 'send-2'],
    ]);
    expect(refreshed).toBe(2);
  });

  test("lets the daemon's refusal through and does not refresh on it", async () => {
    let refreshed = 0;
    const refuse = async (): Promise<never> => {
      throw new Error('it is still typed in the composer');
    };
    await expect(
      sendCanceller({ cancelSend: refuse }, 's-1', () => (refreshed += 1))({ sendId: 'send-1' }),
    ).rejects.toThrow('still typed');
    await expect(
      sendSubmitter({ submitSend: refuse }, 's-1', () => (refreshed += 1))({ sendId: 'send-1' }),
    ).rejects.toThrow('still typed');
    expect(refreshed).toBe(0);
  });
});

describe('startSessionWorkspaceRefresh · nudges and the relaxed poll', () => {
  /** A clock and one pending timeout, driven by hand. */
  const timed = () => {
    const browser = environment();
    let clock = NOW;
    const pending = new Map<number, () => void>();
    const delays: number[] = [];
    const cleared: unknown[] = [];
    let next = 0;
    const env: SessionWorkspaceRefreshEnvironment = {
      ...browser.env,
      now: () => clock,
      setTimeout: (callback, milliseconds) => {
        next += 1;
        pending.set(next, callback);
        delays.push(milliseconds);
        return next;
      },
      clearTimeout: handle => {
        cleared.push(handle);
        pending.delete(handle as number);
      },
    };
    return {
      ...browser,
      env,
      advance: (milliseconds: number) => {
        clock += milliseconds;
      },
      fire: () => {
        const callbacks = [...pending.values()];
        pending.clear();
        for (const callback of callbacks) callback();
      },
      pending: () => pending.size,
      delays,
      cleared,
    };
  };

  const counting = () => {
    let reads = 0;
    return {
      api: {
        logs: async () => {
          reads += 1;
          return 'assistant/message: hello';
        },
        get: async () => sessionView('s-1'),
      },
      reads: () => reads,
    };
  };

  const start = (
    env: SessionWorkspaceRefreshEnvironment,
    api: ReturnType<typeof counting>['api'],
    relaxed?: () => boolean,
  ) =>
    startSessionWorkspaceRefresh({
      api,
      sessionId: 's-1',
      environment: env,
      onTranscript: () => undefined,
      onSession: () => undefined,
      onError: () => undefined,
      ...(relaxed === undefined ? {} : { relaxed }),
    });

  test('should fold a burst of nudges into one read once it settles', async () => {
    // Arrange
    const browser = timed();
    const reader = counting();
    const subject = start(browser.env, reader.api);
    await subject.initial;

    // Act
    subject.nudge();
    subject.nudge();
    subject.nudge();
    const pendingDuringBurst = browser.pending();
    browser.fire();
    await subject.refresh();

    // Assert
    expect(pendingDuringBurst).toBe(1);
    expect(browser.delays).toEqual([NUDGE_SETTLE_MS]);
    expect(reader.reads()).toBe(2);
    subject.stop();
  });

  test('should read at once on a nudge when the environment has no timer', async () => {
    // Arrange
    const browser = environment();
    const reader = counting();
    const subject = start(browser.env, reader.api);
    await subject.initial;

    // Act
    subject.nudge();
    await subject.refresh();

    // Assert
    expect(reader.reads()).toBe(2);
    subject.stop();
  });

  test('should drop a pending nudge on stop, and ignore one after it', async () => {
    // Arrange
    const browser = timed();
    const reader = counting();
    const subject = start(browser.env, reader.api);
    await subject.initial;
    subject.nudge();

    // Act
    subject.stop();
    subject.nudge();
    browser.fire();

    // Assert
    expect(browser.cleared).toEqual([1]);
    expect(browser.pending()).toBe(0);
    expect(reader.reads()).toBe(1);
  });

  test('should stop with no nudge pending without clearing a timer', async () => {
    // Arrange
    const browser = timed();
    const subject = start(browser.env, counting().api);
    await subject.initial;

    // Act
    subject.stop();

    // Assert
    expect(browser.cleared).toEqual([]);
  });

  test.each([
    ['relaxed, inside the window', true, RELAXED_REFRESH_MS - 1, 1],
    ['relaxed, at the window', true, RELAXED_REFRESH_MS, 2],
    ['not relaxed', false, 3_000, 2],
  ])('should poll %s (ticks after %#)', async (_name, relaxed, elapsed, expected) => {
    // Arrange
    const browser = timed();
    const reader = counting();
    const subject = start(browser.env, reader.api, () => relaxed);
    await subject.initial;

    // Act
    browser.advance(elapsed);
    browser.tick();

    // Assert
    expect(reader.reads()).toBe(expected);
    subject.stop();
  });

  test.each([
    ['just after the reader acted', 1_000, 2],
    ['to the end of the watch after acting', ACTED_WATCH_MS - 1, 2],
    ['once the watch after acting is over', ACTED_WATCH_MS, 1],
  ])('should poll a relaxed page %s (ticks after %#)', async (_name, sinceActed, expected) => {
    // Arrange — the feed is up and the agent idle, so the poll would wait out its relaxed window; then the
    // reader sends. A feed that died without a close must not leave that send unwatched for minutes.
    const browser = timed();
    const reader = counting();
    const subject = start(browser.env, reader.api, () => true);
    await subject.initial;
    subject.acted();

    // Act
    browser.advance(sinceActed);
    browser.tick();

    // Assert
    expect(reader.reads()).toBe(expected);
    subject.stop();
  });

  test('should never relax a poll that has no clock', async () => {
    // Arrange
    const browser = environment();
    const reader = counting();
    const subject = start(browser.env, reader.api, () => true);
    await subject.initial;

    // Act
    browser.tick();

    // Assert
    expect(reader.reads()).toBe(2);
    subject.stop();
  });
});

describe('transcriptEntriesFromLog: images', () => {
  const shot = '[fy-image 4096.3145728.0 image/png]';
  const other = '[fy-image 9000.2048.1 image/jpeg]';

  test('a user attachment with a marker becomes a visible user row that carries the image', () => {
    const entries = transcriptEntriesFromLog(`[10:00:00] user/attachment: image ${shot}`, NOW);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user', text: '', at: Date.UTC(2026, 9, 18, 10, 0, 0) });
    expect(entries[0]?.images).toEqual([
      { handle: { recordOffset: 4096, recordLength: 3_145_728, ordinal: 0 }, mediaType: 'image/png' },
    ]);
  });

  test('a ferret attachment with a marker becomes an assistant row', () => {
    const entries = transcriptEntriesFromLog(`assistant/attachment: image ${shot}`);
    expect(entries.map(entry => [entry.kind, entry.images?.length])).toEqual([['assistant', 1]]);
    expect(entries[0]).not.toHaveProperty('at');
  });

  test('an attachment line without a marker stays hidden, as an older daemon wrote it', () => {
    expect(transcriptEntriesFromLog('user/attachment: image\nassistant/attachment: image')).toEqual([]);
  });

  test('a malformed marker leaves the attachment hidden', () => {
    expect(transcriptEntriesFromLog('user/attachment: image [fy-image nope image/png]')).toEqual([]);
  });

  test('an attachment from another role stays hidden even with a marker', () => {
    expect(transcriptEntriesFromLog(`tool/attachment: image ${shot}`)).toEqual([]);
  });

  test('an image row follows a finished tool run and sits between its neighbours in order', () => {
    const entries = transcriptEntriesFromLog(
      [
        'user/message: look',
        'assistant/tool-call: Read({})',
        'tool/tool-result: read',
        `user/attachment: image ${shot}`,
        'assistant/message: seen',
      ].join('\n'),
    );
    expect(entries.map(entry => entry.kind)).toEqual(['user', 'tool', 'user', 'assistant']);
    expect(entries[2]?.images).toHaveLength(1);
  });

  test('a tool result splits its marker lines into images and keeps the text', () => {
    const entries = transcriptEntriesFromLog(
      ['assistant/tool-call: browser_screenshot({})', 'tool/tool-result: captured', `    ${shot}`, `    ${other}`].join(
        '\n',
      ),
    );
    const result = entries[0]?.tools?.[0]?.result;
    expect(result?.text).toBe('captured');
    expect(result?.images?.map(image => image.mediaType)).toEqual(['image/png', 'image/jpeg']);
  });

  test('an image-only tool result has empty text and its image', () => {
    const entries = transcriptEntriesFromLog(
      ['assistant/tool-call: browser_screenshot({})', `tool/tool-result: ${shot}`].join('\n'),
    );
    const result = entries[0]?.tools?.[0]?.result;
    expect(result?.text).toBe('');
    expect(result?.images).toHaveLength(1);
  });

  test('a failed result keeps its error tone and its images', () => {
    const entries = transcriptEntriesFromLog(
      ['assistant/tool-call: Read({})', `tool/tool-result: error timed out ${shot}`].join('\n'),
    );
    expect(entries[0]?.tools?.[0]?.result).toMatchObject({ text: 'timed out', isError: true });
    expect(entries[0]?.tools?.[0]?.result?.images).toHaveLength(1);
  });

  test('a tool result with a malformed marker keeps it as text and carries no images', () => {
    const entries = transcriptEntriesFromLog(
      ['assistant/tool-call: Read({})', 'tool/tool-result: see [fy-image bad image/png]'].join('\n'),
    );
    const result = entries[0]?.tools?.[0]?.result;
    expect(result).toEqual({ text: 'see [fy-image bad image/png]' });
  });
});
