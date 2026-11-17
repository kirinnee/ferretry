import { describe, expect, it } from 'bun:test';
import { MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import type { AgendaCall } from '../../../app/lib/agenda-call.ts';
import type { AgendaFleet } from '../../../app/lib/agenda-fleet.ts';
import type { InboxCard } from '../../../app/lib/agenda-inbox.ts';
import { inboxConversationReader } from '../../../app/lib/inbox-conversation.ts';
import type { DaemonId } from '../../../app/lib/machine.ts';

const HERE = 'here' as DaemonId;
const OTHER = 'other' as DaemonId;

/** A machine whose one ferret said `lines`, answering Conversation's two routes by key; `reads` records who was asked. */
const machine = (name: string, lines: readonly string[], reads: string[]): AgendaCall => ({
  call: (async (route: string, init?: { params?: { ferretId?: string } }) => {
    reads.push(`${name} ${route} ${init?.params?.ferretId ?? ''}`);
    if (route === 'GET /v1/ferrets/:ferretId/messages')
      return {
        v: 1,
        ferret: init?.params?.ferretId,
        nextCursor: null,
        previousCursor: null,
        messages: lines.map((text, at) => ({ point: `${name}-${at}`, role: 'user', text, selectionBinding: 'b' })),
      };
    return { sends: [] };
  }) as AgendaCall['call'],
});

const card = (daemonId: DaemonId, session: string): InboxCard =>
  ({
    daemonId,
    view: { config: { id: session } },
    item: { id: 'A4', waitingSince: '2026-08-10T00:00:00.000Z' },
  }) as unknown as InboxCard;

describe('inboxConversationReader', () => {
  it('reads the card’s ferret through the page’s own client when the card is the page’s machine’s', async () => {
    const reads: string[] = [];
    const read = inboxConversationReader({ daemon: HERE, client: machine('here', ['reply ^A4 now'], reads) });
    const entries = await read(card(HERE, 'ferret-1'));
    expect(entries.map(entry => entry.text)).toEqual(['reply ^A4 now']);
    expect(reads).toEqual([
      'here GET /v1/ferrets/:ferretId/messages ferret-1',
      'here GET /v1/ferrets/:ferretId/sends ferret-1',
    ]);
  });

  it('reads another machine’s card through that machine’s client, never the page’s', async () => {
    const reads: string[] = [];
    const fleet = { clientOf: (id: DaemonId) => (id === OTHER ? machine('other', ['^A4 there'], reads) : undefined) };
    const read = inboxConversationReader(
      { daemon: HERE, client: machine('here', ['wrong machine'], reads) },
      fleet as unknown as AgendaFleet,
    );
    const entries = await read(card(OTHER, 'ferret-2'));
    expect(entries.map(entry => entry.text)).toEqual(['^A4 there']);
    expect(reads.every(line => line.startsWith('other '))).toBe(true);
  });

  it('reads nothing of a machine this device holds no client for, and sends nothing to the page’s machine instead', async () => {
    const reads: string[] = [];
    const none = { clientOf: () => undefined };
    const unreachable = inboxConversationReader(
      { daemon: HERE, client: machine('here', ['^A4'], reads) },
      none as unknown as AgendaFleet,
    );
    expect(await unreachable(card(OTHER, 'ferret-2'))).toEqual([]);
    const alone = inboxConversationReader({ daemon: HERE, client: machine('here', ['^A4'], reads) });
    expect(await alone(card(OTHER, 'ferret-2'))).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('reads nothing of the machine agenda: it has no ferret, so no conversation', async () => {
    const reads: string[] = [];
    const read = inboxConversationReader({ daemon: HERE, client: machine('here', ['^A4'], reads) });
    expect(await read(card(HERE, MACHINE_AGENDA_ID))).toEqual([]);
    expect(reads).toEqual([]);
  });
});
