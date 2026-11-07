import { type SessionAgendaSummary } from '../../../contract/wire.ts';
import { describe, expect, it } from 'bun:test';
import {
  MACHINE_AGENDA_READ,
  SESSION_AGENDA_READ,
  SESSION_AGENDA_REPLIES,
  sessionAgendaSummary,
} from '../../../app/lib/agenda-wire.ts';
import { requestOf } from '../../support/app/call-from-fetch.ts';

describe('the agenda route keys', () => {
  it('name every route as the daemon serves it', () => {
    expect(requestOf(SESSION_AGENDA_READ, { params: { ferretId: 's 1' } }).url).toEndWith('/v1/ferrets/s%201/agenda');
    expect(requestOf(SESSION_AGENDA_REPLIES, { params: { ferretId: 's 1' } }).url).toEndWith(
      '/v1/ferrets/s%201/agenda/replies',
    );
    expect(MACHINE_AGENDA_READ).toBe('GET /v1/machine/agenda');
  });
});

describe('the ferret summary', () => {
  const summary = (first: string): SessionAgendaSummary => ({
    open: 1,
    first,
    ask: 'Rebase now?',
    latestAt: '2026-10-23T12:00:00.000Z',
  });

  it('reads the agenda summary the daemon wrote', () => {
    expect(sessionAgendaSummary({ agenda: summary('A2') })?.first).toBe('A2');
    expect(sessionAgendaSummary({})).toBeUndefined();
  });
});
