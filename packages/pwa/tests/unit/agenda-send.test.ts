import { describe, expect, it } from 'bun:test';
import type { AgendaResponse } from '@ferretry/protocol';
import type { InboxAction } from '../../src/lib/agenda-answers.ts';
import { type AgendaSender, sendAgendaAction } from '../../src/lib/agenda-send.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';

const connection = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const scope = daemonSessionScope(connection, 'fr');

const recorder = () => {
  const calls: unknown[][] = [];
  const log =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args.slice(2)]);
    };
  const sender = {
    respond: log('respond'),
    dismiss: log('dismiss'),
    resolve: log('resolve'),
    needsInfo: log('needsInfo'),
    discuss: log('discuss'),
    snooze: log('snooze'),
    unsnooze: log('unsnooze'),
  } as unknown as AgendaSender;
  return { calls, sender };
};

const sent = async (action: InboxAction) => {
  const { calls, sender } = recorder();
  await sendAgendaAction(sender, connection, scope, 'A1', action);
  return calls;
};

describe('sendAgendaAction', () => {
  const response: AgendaResponse = { kind: 'permission', decision: 'approve' };

  it('sends each kind of action as exactly one request', async () => {
    expect(await sent({ kind: 'respond', label: 'Allow', response, note: 'n' })).toEqual([
      ['respond', 'A1', response, 'n'],
    ]);
    expect(await sent({ kind: 'dismiss', label: 'Dismiss', note: 'n' })).toEqual([['dismiss', 'A1', 'n']]);
    expect(await sent({ kind: 'needs-info', label: 'More', note: 'n' })).toEqual([['needsInfo', 'A1', 'n']]);
    expect(await sent({ kind: 'discuss', label: 'Discuss', note: 'n' })).toEqual([['discuss', 'A1', 'n']]);
    expect(await sent({ kind: 'resolve', label: 'Done', note: 'n' })).toEqual([['resolve', 'A1', 'n']]);
  });

  it('snoozes until an instant, and unsnoozes with no instant', async () => {
    expect(await sent({ kind: 'snooze', label: 'Snooze', until: '2026-10-30T15:00:00.000Z' })).toEqual([
      ['snooze', 'A1', '2026-10-30T15:00:00.000Z'],
    ]);
    expect(await sent({ kind: 'unsnooze', label: 'Back to my list' })).toEqual([['unsnooze', 'A1']]);
  });
});
