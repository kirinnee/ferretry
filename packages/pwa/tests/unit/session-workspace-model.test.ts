import { describe, expect, test } from 'bun:test';

import {
  type SessionWorkspaceRefreshEnvironment,
  startSessionWorkspaceRefresh,
  transcriptEntriesFromLog,
} from '../../src/components/session-workspace-model.ts';
import { sessionView } from '../support/sessions.ts';

describe('transcriptEntriesFromLog', () => {
  test('projects normalized user and assistant messages with multiline Markdown intact', () => {
    const entries = transcriptEntriesFromLog(
      '[10:11:12] user/message: Please ship it\n[10:11:13] assistant/message: ## Done\n    - built\n    - tested',
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'user', label: 'You · 10:11:12', text: 'Please ship it' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      label: 'Assistant · 10:11:13',
      text: '## Done\n- built\n- tested',
    });
    expect(entries[0]?.id).not.toBe(entries[1]?.id);
  });

  test('keeps machine records as labelled chrome instead of pretending they are messages', () => {
    const entries = transcriptEntriesFromLog(
      [
        'assistant/reasoning: check the tree',
        'tool/tool-call: Read({"path":"src/App.tsx"})',
        'tool/tool-result: output',
        'developer/settings: {"model":"opus"}',
        'system/turn: completed',
      ].join('\n'),
    );

    expect(entries.map(entry => [entry.kind, entry.label, entry.text])).toEqual([
      ['notice', 'Reasoning', 'check the tree'],
      ['notice', 'Tool · Tool Call', 'Read({"path":"src/App.tsx"})'],
      ['notice', 'Tool · Tool Result', 'output'],
      ['notice', 'Developer', '{"model":"opus"}'],
      ['notice', 'System', 'completed'],
    ]);
  });

  test('preserves malformed leading evidence and non-indented continuation text', () => {
    const entries = transcriptEntriesFromLog('unparsed evidence\r\nassistant/message: hello\r\ncontinuation');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'notice', label: 'Transcript', text: 'unparsed evidence' });
    expect(entries[1]).toMatchObject({ kind: 'assistant', text: 'hello\ncontinuation' });
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
