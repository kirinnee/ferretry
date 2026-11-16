import { describe, expect, test } from 'bun:test';
import { statusMark } from '@ferretry/app';
import { chatSessionOf, isUnread, UNREAD_STATUS, unreadChatSession } from '../../../../app/chat/chat-session.ts';
import { sessionTurn } from '../../../../app/transcript/session-activity.ts';
import { ferretSummary } from '../../../support/app/ferret-view.ts';

/**
 * THE FERRET AS THE CHAT DRAWS IT, from what Ferrets' route serves. Every summary here is built through Ferrets' own
 * `FerretSummarySchema` (`ferretSummary`), so a case can only feed the shape the route can answer.
 */

describe('Ferrets’ summary, as the chat draws it', () => {
  test('names the ferret: its id, its callsign, its task title and the runtime it runs on', () => {
    const session = chatSessionOf(
      ferretSummary('f1', { name: 'daisy', title: 'Fix the chat', runtime: 'claude-llm1' }),
    );
    expect(session.config).toEqual({ id: 'f1', teammate: 'daisy', name: 'Fix the chat', agent: 'claude-llm1' });
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
    for (const field of ['turnStateAt', 'activity', 'pendingQuestion', 'permissionRequest', 'harnessDialog'] as const)
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
