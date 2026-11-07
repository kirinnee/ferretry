import { describe, expect, it } from 'bun:test';
import { sessionAgendaPath, sessionAgendaRepliesPath, sessionAgendaSummary } from '../../../app/lib/agenda-wire.ts';
import type { SessionAgendaSummary } from '../../../app/wire/index.ts';

describe('the agenda paths', () => {
  it('spells every path as the daemon serves it', () => {
    expect(sessionAgendaPath('s 1')).toBe('/v1/ferrets/s%201/agenda');
    expect(sessionAgendaRepliesPath('s 1')).toBe('/v1/ferrets/s%201/agenda/replies');
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
