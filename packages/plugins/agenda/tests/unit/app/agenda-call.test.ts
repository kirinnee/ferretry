import { describe, expect, it } from 'bun:test';
import { AGENDA_READ_HEADERS, agendaCall, DaemonResponseError, responseError } from '../../../app/lib/agenda-call.ts';
import { boardReadFailure } from '../../../app/lib/inbox-board-reads.ts';

const failing = (failure: unknown) => ({
  call: async () => {
    throw failure;
  },
});

describe('what a failed call is', () => {
  it('sends the agenda channel on every read', () => {
    expect(AGENDA_READ_HEADERS).toEqual({ 'x-fy-agenda-channel': '2' });
  });

  it('an answer the daemon gave is a DaemonResponseError, with its status', async () => {
    const refused = await agendaCall(failing({ status: 403, code: 'forbidden', message: 'closed' }), 'GET /x').catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(DaemonResponseError);
    expect(refused).toMatchObject({ status: 403, code: 'forbidden', message: 'closed' });
  });

  it('a timeout is passed on as it came, so the Inbox says "timed out"', async () => {
    const timeout = new DOMException('too slow', 'TimeoutError');
    const caught = await agendaCall(failing(timeout), 'GET /x').catch((error: unknown) => error);
    expect(caught).toBe(timeout);
    expect(boardReadFailure(caught)).toBe('timed-out');
  });

  it('a dropped session (no status) is passed on as it came, so the Inbox says "no answer"', async () => {
    const dropped = new Error('session closed');
    const caught = await agendaCall(failing(dropped), 'GET /x').catch((error: unknown) => error);
    expect(caught).toBe(dropped);
    expect(boardReadFailure(caught)).toBe('no-answer');
  });

  it('an answer with no words of its own reads HTTP N and carries no code, as it always did', () => {
    const bare = responseError({ status: 502, code: 'http_502', message: 'The daemon answered 502.' });
    expect(bare).toMatchObject({ status: 502, message: 'HTTP 502' });
    expect(bare.code).toBeUndefined();
  });
});
