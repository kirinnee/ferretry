import { describe, expect, test } from 'bun:test';
import { statusMark } from '@ferretry/app';
import { chatPromptOf } from '../../../../app/chat/chat-prompt.ts';
import { chatSessionOf, isUnread, UNREAD_STATUS, unreadChatSession } from '../../../../app/chat/chat-session.ts';
import { sessionTurn } from '../../../../app/transcript/session-activity.ts';
import { ferretSummary } from '../../../support/app/ferret-view.ts';

/**
 * THE FERRET AS THE CHAT DRAWS IT, from what Ferrets' route serves. Every summary here is built through Ferrets' own
 * `FerretSummarySchema` (`ferretSummary`), so a case can only feed the shape the route can answer.
 */

describe('Ferrets’ summary, as the chat draws it', () => {
  test('names the ferret: its id, its callsign, its task title and the login it runs on', () => {
    const session = chatSessionOf(ferretSummary('f1', { name: 'daisy', title: 'Fix the chat', login: 'llm1' }));
    expect(session.config).toEqual({
      id: 'f1',
      teammate: 'daisy',
      name: 'Fix the chat',
      login: 'llm1',
      harness: 'claude',
    });
  });

  test('keys the composer’s usage by the LOGIN, never by the runtime’s name (Usage’s feed is keyed by login)', () => {
    const withBoth = chatSessionOf(ferretSummary('f1', { runtime: 'claude-llm1', login: 'llm1' }));
    expect(withBoth.config.login).toBe('llm1');
    expect(JSON.stringify(withBoth.config)).not.toContain('claude-llm1');
    // A ferret with a runtime but no login has no feed row to look up: no key, so no guess.
    expect(chatSessionOf(ferretSummary('f1', { runtime: 'claude-llm1' })).config.login).toBeUndefined();
  });

  test('spells the harness as the composer takes it: Codex is codex, Claude Code is claude', () => {
    expect(chatSessionOf(ferretSummary('f1', { harness: 'codex' })).config.harness).toBe('codex');
    expect(chatSessionOf(ferretSummary('f1', { harness: 'claude-code' })).config.harness).toBe('claude');
  });

  test('a working ferret is live and working; an idle one is live and waiting on the person', () => {
    const working = chatSessionOf(ferretSummary('f1', { state: 'working' }));
    expect(working.state).toMatchObject({ status: 'running', turnState: 'working' });
    expect(sessionTurn(working)).toBe('working');

    const idle = chatSessionOf(ferretSummary('f1', { state: 'idle' }));
    expect(idle.state).toMatchObject({ status: 'running', turnState: 'your-turn' });
    expect(sessionTurn(idle)).toBe('your-turn');
  });

  test('a starting ferret claims no turn yet', () => {
    const session = chatSessionOf(ferretSummary('f1', { state: 'starting' }));
    expect(session.state.status).toBe('starting');
    expect(session.state.turnState).toBeUndefined();
    expect(session.state.turnStateAt).toBeUndefined();
  });

  test('the registry’s stateAt is never the turn’s date: with no prompt read the turn is undated', () => {
    const at = '2026-11-05T03:00:09.000Z';
    for (const state of ['working', 'idle', 'stopped'] as const)
      expect(chatSessionOf(ferretSummary('f1', { state, stateAt: at })).state.turnStateAt).toBeUndefined();
  });

  test('a live ferret’s turn is the observer’s: its state (needs-input kept), its instant, its words and its prompts', () => {
    const at = '2026-11-05T03:00:09.000Z';
    const request = {
      id: '0123456789abcdef',
      harness: 'claude',
      tool: 'Bash',
      action: 'run',
      question: 'Run it?',
      options: [
        { number: 1, label: 'Yes', kind: 'allow' },
        { number: 2, label: 'No', kind: 'deny' },
      ],
      selected: 1,
    };
    const prompt = chatPromptOf({
      turnState: 'needs-input',
      turnStateAt: at,
      prompt: 'Run it?',
      permissionRequest: request,
    });
    const session = chatSessionOf(ferretSummary('f1', { state: 'idle', stateAt: '2026-11-05T03:00:30.000Z' }), prompt);
    expect(session.state).toMatchObject({
      status: 'running',
      turnState: 'needs-input',
      turnStateAt: at,
      turnPrompt: 'Run it?',
    });
    expect(session.state.permissionRequest?.question).toBe('Run it?');

    const dialog = {
      id: '0123456789abcdef',
      harness: 'claude',
      kind: 'other',
      title: 'Trust this folder?',
      options: [{ number: 1, label: 'Yes', grantsTrust: true }],
      selected: 1,
    };
    const asked = chatSessionOf(
      ferretSummary('f1', { state: 'idle' }),
      chatPromptOf({ turnState: 'needs-input', turnStateAt: at, dialog }),
    );
    expect(asked.state.harnessDialog?.title).toBe('Trust this folder?');
  });

  test('a ferret that is not live is stopped on nothing, whatever the prompt read says', () => {
    const prompt = chatPromptOf({
      turnState: 'needs-input',
      turnStateAt: '2026-11-05T03:00:09.000Z',
      prompt: 'Run it?',
    });
    for (const state of ['starting', 'stopped'] as const) {
      const session = chatSessionOf(ferretSummary('f1', { state }), prompt);
      expect(session.state.turnStateAt).toBeUndefined();
      expect(session.state.turnPrompt).toBeUndefined();
    }
  });

  test('the prompt read is narrowed part by part: an unreadable part, a date without its state, or a non-object drops only itself', () => {
    expect(chatPromptOf('nope')).toBeUndefined();
    expect(chatPromptOf({ turnStateAt: '2026-11-05T03:00:09.000Z' })).toEqual({});
    expect(
      chatPromptOf({
        turnState: 'bogus',
        turnStateAt: 'not a date',
        permissionRequest: { nope: 1 },
        dialog: 3,
        prompt: 4,
      }),
    ).toEqual({});
    expect(chatPromptOf({ turnState: 'your-turn', turnStateAt: '2026-11-05T03:00:09.000Z' })).toEqual({
      turnState: 'your-turn',
      turnStateAt: '2026-11-05T03:00:09.000Z',
    });
  });

  test('a stopped ferret is finished: completed when it said `signal done`, stopped otherwise', () => {
    const stopped = chatSessionOf(ferretSummary('f1', { state: 'stopped' }));
    expect(stopped.state.status).toBe('stopped');
    expect(statusMark(stopped).klass).toBe('finished');
    const done = chatSessionOf(ferretSummary('f1', { state: 'stopped', finishedAt: '1970-01-01T00:00:02.000Z' }));
    expect(done.state.status).toBe('completed');
    expect(statusMark(done).tone).toBe('ok');
  });

  test('a declared wait and the runtime’s usage carry over, in the names the chat reads', () => {
    const session = chatSessionOf(
      ferretSummary('f1', {
        waiting: { since: '1970-01-01T00:00:02.000Z', condition: 'CI', peerName: 'freddie' },
        quota: { authOk: true, fiveHourPercent: 40, weeklyPercent: 10, atLimit: false },
      }),
    );
    expect(session.state.waiting).toEqual({ since: '1970-01-01T00:00:02.000Z', condition: 'CI', peerName: 'freddie' });
    expect(session.state).toMatchObject({
      usageAuthOk: true,
      usage5hPercent: 40,
      usageWeeklyPercent: 10,
      usageAtLimit: false,
    });
    expect(statusMark(session).label).toBe('waiting — parked for freddie: CI');
  });

  test('what the summary does not carry is absent, never invented', () => {
    const session = chatSessionOf(ferretSummary('f1'));
    for (const field of ['activity', 'pendingQuestion', 'permissionRequest', 'harnessDialog'] as const)
      expect(session.state[field]).toBeUndefined();
    expect(session.context).toBeUndefined();
  });
});

describe('a ferret the chat could not read', () => {
  test('is drawn from its id alone and claims no status', () => {
    const session = unreadChatSession('f1');
    expect(session).toEqual({ config: { id: 'f1' }, state: { status: UNREAD_STATUS } });
    expect(isUnread(session)).toBe(true);
    expect(sessionTurn(session)).toBeNull();
    expect(isUnread(chatSessionOf(ferretSummary('f1')))).toBe(false);
  });
});
