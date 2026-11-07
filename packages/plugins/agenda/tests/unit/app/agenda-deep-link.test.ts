/** The card a link opens (`#agenda/<id>?session=<sid>`): the fragment names a card and a session, and nothing more. */

import { describe, expect, it } from 'bun:test';
import type { DaemonId } from '../../../app/shell.ts';
import { agendaDeepLinkFromHash, machineForAgendaLink } from '../../../app/lib/agenda-inbox.ts';

const machine = (daemonId: string, sessionIds: readonly string[] | null) => ({
  daemonId: daemonId as DaemonId,
  sessionIds,
});

describe('agendaDeepLinkFromHash', () => {
  it('reads the card and the session', () => {
    expect(agendaDeepLinkFromHash('#agenda/A8?session=sess-1')).toEqual({ id: 'A8', sessionId: 'sess-1' });
  });

  it('reads the machine a link names, and drops a link naming something that is not a daemon id', () => {
    const named = `fy_daemon_${'a'.repeat(43)}`;
    expect(agendaDeepLinkFromHash(`#agenda/A8?session=sess-1&machine=${named}`)).toEqual({
      id: 'A8',
      sessionId: 'sess-1',
      machine: named as DaemonId,
    });
    expect(agendaDeepLinkFromHash('#agenda/A8?session=sess-1&machine=nope')).toBeNull();
  });

  it('reads a card with no session', () => {
    expect(agendaDeepLinkFromHash('#agenda/A8')).toEqual({ id: 'A8' });
  });

  it('is not another fragment, nor a malformed card id', () => {
    expect(agendaDeepLinkFromHash('')).toBeNull();
    expect(agendaDeepLinkFromHash('#join=abc')).toBeNull();
    expect(agendaDeepLinkFromHash('#agenda/not%20an%20id')).toBeNull();
    expect(agendaDeepLinkFromHash('#agenda/%E0%A4')).toBeNull();
  });
});

describe('machineForAgendaLink', () => {
  const link = { id: 'A8', sessionId: 'sess-1' } as { id: never; sessionId: string };

  it('is the machine whose session list holds the session', () => {
    const holder = machine('b', ['sess-1']);
    expect(machineForAgendaLink(link, [machine('a', ['x']), holder])).toBe(holder.daemonId);
  });

  it('is the machine the link names when it is paired, without waiting for any session list', () => {
    const named = machine('b', null);
    expect(machineForAgendaLink({ ...link, machine: named.daemonId }, [machine('a', ['x']), named])).toBe(
      named.daemonId,
    );
    expect(machineForAgendaLink({ ...link, machine: 'c' as DaemonId }, [machine('a', ['sess-1'])])).toBe(
      'a' as DaemonId,
    );
  });

  it('waits while a machine that might hold it has not been read', () => {
    expect(machineForAgendaLink(link, [machine('a', ['x']), machine('b', null)])).toBe('wait');
  });

  it('is nothing when every machine was read and none holds it, or the link names no session', () => {
    expect(machineForAgendaLink(link, [machine('a', ['x'])])).toBeUndefined();
    expect(machineForAgendaLink({ id: 'A8' } as never, [machine('a', ['sess-1'])])).toBeUndefined();
  });
});
