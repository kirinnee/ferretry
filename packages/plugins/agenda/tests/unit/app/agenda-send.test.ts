import { describe, expect, it } from 'bun:test';
import type { AgendaResponse } from '../../../app/wire/index.ts';
import type { InboxAction } from '../../../app/lib/agenda-answers.ts';
import { type AgendaSender, sendAgendaAction } from '../../../app/lib/agenda-send.ts';
import { daemonConnection } from '../../../app/shell.ts';
import { daemonSessionScope } from '../../../app/shell.ts';

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
      ['respond', 'A1', response, 'n', undefined, undefined, undefined],
    ]);
    expect(await sent({ kind: 'dismiss', label: 'Dismiss', note: 'n' })).toEqual([['dismiss', 'A1', 'n', undefined]]);
    expect(await sent({ kind: 'needs-info', label: 'More', note: 'n' })).toEqual([['needsInfo', 'A1', 'n']]);
    expect(await sent({ kind: 'discuss', label: 'Discuss', note: 'n' })).toEqual([['discuss', 'A1', 'n']]);
    expect(await sent({ kind: 'resolve', label: 'Done', note: 'n' })).toEqual([['resolve', 'A1', 'n', undefined]]);
  });

  it('carries the ask version a Done or a Skip was given from, to the one client call', async () => {
    expect(await sent({ kind: 'resolve', label: 'Mark as done', askVersion: 2 })).toEqual([
      ['resolve', 'A1', undefined, 2],
    ]);
    expect(await sent({ kind: 'dismiss', label: 'Skip', askVersion: 3 })).toEqual([['dismiss', 'A1', undefined, 3]]);
  });

  it('marks an answer to the gate attached to a thread', async () => {
    const choice: AgendaResponse = { kind: 'multiple-choice', choice: 'Done' };
    expect(await sent({ kind: 'respond', label: 'Done', response: choice, gate: true })).toEqual([
      ['respond', 'A1', choice, undefined, true, undefined, undefined],
    ]);
  });

  it('carries the card ask an answer was given to, to the one client call', async () => {
    const choice: AgendaResponse = { kind: 'multiple-choice', choice: 'Done' };
    expect(
      await sent({ kind: 'respond', label: 'Done', response: choice, gate: true, cardAsk: 'gate:F1:tested:2' }),
    ).toEqual([['respond', 'A1', choice, undefined, true, undefined, undefined, 'gate:F1:tested:2']]);
  });

  it('carries the ask version an answer was given to, to the one client call', async () => {
    const choice: AgendaResponse = { kind: 'multiple-choice', choice: 'EU' };
    expect(await sent({ kind: 'respond', label: 'EU', response: choice, askVersion: 2 })).toEqual([
      ['respond', 'A1', choice, undefined, undefined, undefined, 2],
    ]);
  });

  it('carries the files of a Not good with its answer', async () => {
    const choice: AgendaResponse = { kind: 'multiple-choice', choice: 'Not good' };
    const attachments = { from: 'fr', ids: [`att_${'a'.repeat(64)}`] };
    expect(await sent({ kind: 'respond', label: 'Not good', response: choice, attachments })).toEqual([
      ['respond', 'A1', choice, undefined, undefined, attachments, undefined],
    ]);
  });

  it('snoozes until an instant, and unsnoozes with no instant', async () => {
    expect(await sent({ kind: 'snooze', label: 'Snooze', until: '2026-10-30T15:00:00.000Z' })).toEqual([
      ['snooze', 'A1', '2026-10-30T15:00:00.000Z'],
    ]);
    expect(await sent({ kind: 'unsnooze', label: 'Back to my list' })).toEqual([['unsnooze', 'A1']]);
  });
});
