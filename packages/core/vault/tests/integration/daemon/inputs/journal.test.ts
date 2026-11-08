import { describe, expect, test } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { HoldEvidenceSchema, HoldsFile, InputRequestFiles } from '../../../../contract/index.ts';
import { InputStateJournal } from '../../../../daemon/adapters/inputs/journal.ts';
import {
  type AgendaId,
  INPUT_JOURNAL_EVENT_TYPES,
  INPUT_QUARANTINE_EVENT_TYPES,
  type InputEvent,
  type InputQuarantineEvent,
  type InputRequest,
} from '../../../../daemon/lib/inputs/wire.ts';

const REQUEST = 'a'.repeat(32);
const AT = '2026-11-07T12:00:00.000Z';
const UNTIL = '2026-11-07T12:02:00.000Z';
function fixture() {
  const folder = new MemoryStateFolder();
  const journal = new InputStateJournal(
    folder.port([HoldsFile, InputRequestFiles]),
    async () => undefined,
    () => AT,
  );
  return { folder, journal };
}
function event(attempt: number, extra: Partial<InputQuarantineEvent> = {}): InputQuarantineEvent {
  return {
    type: INPUT_QUARANTINE_EVENT_TYPES.started,
    sessionId: 'f1',
    hold: `${REQUEST}/${attempt}`,
    names: ['dev', '%3'],
    at: AT,
    until: UNTIL,
    ...extra,
  };
}

test('I78 I84 durable evidence preserves separate attempts, grouped aliases and explicit unresolved state', async () => {
  const { folder, journal } = fixture();
  const first = event(1);
  const second = event(2, { unresolved: true });
  const ended = event(1, { type: INPUT_QUARANTINE_EVENT_TYPES.ended });
  await journal.quarantine('f1', first);
  await journal.quarantine('f1', second);
  await journal.quarantine('f1', ended);
  expect(await journal.quarantines('f1')).toEqual([first, { ...second, until: AT }, ended]);
  expect(await journal.quarantines('f2')).toEqual([]);
  const lines = (folder.raw(HoldsFile) ?? '')
    .trim()
    .split('\n')
    .map(line => HoldEvidenceSchema.parse(JSON.parse(line)));
  expect(lines.map(line => line.hold)).toEqual([`${REQUEST}/1`, `${REQUEST}/2`, `${REQUEST}/1`]);
  expect(lines.every(line => line.names.join(',') === 'dev,%3')).toBe(true);
  const evidence = lines[0];
  expect(HoldEvidenceSchema.safeParse({ ...evidence, names: [] }).success).toBe(false);
  expect(HoldEvidenceSchema.safeParse({ ...evidence, names: Array.from({ length: 33 }, () => 'dev') }).success).toBe(
    false,
  );
  expect(HoldEvidenceSchema.safeParse({ ...evidence, hold: '' }).success).toBe(false);
  expect(HoldEvidenceSchema.safeParse({ ...evidence, ferret: '' }).success).toBe(false);
});

test('I82 hold discovery and replay never read mutable request records; damaged history fails closed', async () => {
  const { folder, journal } = fixture();
  folder.plant(InputRequestFiles, '{damaged', REQUEST);
  await journal.quarantine('f1', event(1));
  expect(await journal.quarantineSessions()).toEqual(['f1']);
  expect(await journal.quarantines('f1')).toEqual([event(1)]);
  await expect(journal.history('f1')).rejects.toThrow('input request record cannot be read');
  await expect(journal.promptOf(REQUEST)).rejects.toThrow('input request record cannot be read');
});

describe('the request records', () => {
  const RAISED = '2026-11-07T11:59:00.000Z';
  const request = (over: Partial<InputRequest> = {}): InputRequest =>
    ({
      id: REQUEST,
      sessionId: 'f1',
      agendaItemId: 'A7',
      target: { kind: 'terminal', key: 'dev' },
      prompt: 'Password:',
      sensitivity: 'secret',
      fields: [
        { id: 'user', label: 'User', sensitivity: 'plain', element: { kind: 'selector', selector: '#u' } },
        { id: 'pass', sensitivity: 'secret' },
        { id: 'code', label: 'Code', sensitivity: 'code' },
      ],
      submit: 'offer-owner',
      raisedAt: RAISED,
      expiresAt: UNTIL,
      state: 'pending',
      ...over,
    }) as unknown as InputRequest;
  const published = (state: InputEvent['state'], type: InputEvent['type'], extra: Partial<InputEvent> = {}) =>
    ({
      type,
      requestId: REQUEST,
      agendaItemId: 'A7',
      sessionId: 'f1',
      target: { kind: 'terminal', key: 'dev' },
      sensitivity: 'secret',
      state,
      at: AT,
      ...extra,
    }) as InputEvent;

  function withCards(cards: Record<string, string>) {
    const folder = new MemoryStateFolder();
    const journal = new InputStateJournal(
      folder.port([HoldsFile, InputRequestFiles]),
      async id => cards[id] as AgendaId | undefined,
      () => AT,
    );
    return { folder, journal };
  }

  test('a request is kept as the ferret raised it, with no value, and read back as its journal events', async () => {
    const { folder, journal } = withCards({ [REQUEST]: 'A7' });
    await journal.publish(
      'f1',
      published('pending', INPUT_JOURNAL_EVENT_TYPES.requested, { expiresAt: UNTIL }),
      request({
        chain: 'A3' as InputRequest['chain'],
        source: { kind: 'sealed', name: 'copy1', from: { kind: 'clipboard' } },
      }),
    );
    const stored = JSON.parse(folder.raw(InputRequestFiles, REQUEST) ?? '{}');
    expect(stored.raise).toEqual({
      target: { kind: 'terminal', key: 'dev' },
      prompt: 'Password:',
      fields: [
        { id: 'user', label: 'User', sensitivity: 'plain', element: { kind: 'selector', selector: '#u' } },
        { id: 'pass', sensitivity: 'secret' },
        { id: 'code', label: 'Code', sensitivity: 'code' },
      ],
      submit: 'offer-owner',
      chain: 'A3',
      source: { kind: 'sealed', name: 'copy1' },
    });
    expect(stored).toMatchObject({ format: 1, id: REQUEST, ferret: 'f1', state: 'pending', raisedAt: RAISED });
    expect(await journal.promptOf(REQUEST)).toBe('Password:');
    expect(await journal.history('f1')).toEqual([
      {
        type: INPUT_JOURNAL_EVENT_TYPES.requested,
        requestId: REQUEST,
        agendaItemId: 'A7',
        sessionId: 'f1',
        target: { kind: 'terminal', key: 'dev' },
        sensitivity: 'secret',
        submit: 'offer-owner',
        sealed: 'copy1',
        state: 'pending',
        expiresAt: UNTIL,
        at: RAISED,
      },
    ]);
  });

  test('a later event moves the state and keeps what the first one raised, its instants and its reason', async () => {
    const { journal } = withCards({ [REQUEST]: 'A7' });
    await journal.publish(
      'f1',
      published('pending', INPUT_JOURNAL_EVENT_TYPES.requested, { expiresAt: UNTIL }),
      request(),
    );
    await journal.publish(
      'f1',
      published('expired', INPUT_JOURNAL_EVENT_TYPES.expired, { reason: 'expired' as InputEvent['reason'] }),
    );
    const [event] = await journal.history('f1');
    expect(event).toMatchObject({
      type: INPUT_JOURNAL_EVENT_TYPES.expired,
      state: 'expired',
      reason: 'expired',
      expiresAt: UNTIL,
      at: RAISED,
    });
    expect(event?.sealed).toBeUndefined();
  });

  test('an event for a request nothing was raised for keeps nothing', async () => {
    const { folder, journal } = withCards({});
    await journal.publish('f1', published('cancelled', INPUT_JOURNAL_EVENT_TYPES.cancelled));
    expect(folder.raw(InputRequestFiles, REQUEST)).toBeUndefined();
    expect(await journal.history('f1')).toEqual([]);
    expect(await journal.promptOf(REQUEST)).toBeUndefined();
  });

  test('a record that named one sensitivity instead of fields is as careful as that one', async () => {
    const { folder, journal } = withCards({ [REQUEST]: 'A7' });
    folder.plant(
      InputRequestFiles,
      JSON.stringify({
        format: 1,
        id: REQUEST,
        ferret: 'f1',
        raise: { target: { kind: 'page', key: 'login' }, prompt: 'Sign in', sensitivity: 'private', submit: 'agent' },
        state: 'delivered',
        raisedAt: RAISED,
        expiresAt: UNTIL,
      }),
      REQUEST,
    );
    const [event] = await journal.history('f1');
    // A record that never named fields is as careful as the one sensitivity it did name.
    expect(event).toMatchObject({ sensitivity: 'private', submit: 'agent', type: INPUT_JOURNAL_EVENT_TYPES.delivered });
  });

  test('history is the asking ferret’s own, and a request whose card is gone is not replayed', async () => {
    const other = 'b'.repeat(32);
    const { journal } = withCards({ [REQUEST]: 'A7' });
    await journal.publish('f1', published('pending', INPUT_JOURNAL_EVENT_TYPES.requested), request());
    await journal.publish(
      'f2',
      published('pending', INPUT_JOURNAL_EVENT_TYPES.requested, { requestId: other, sessionId: 'f2' }),
      request({ id: other, sessionId: 'f2' } as Partial<InputRequest>),
    );
    expect((await journal.history('f1')).map(event => event.requestId)).toEqual([REQUEST]);
    expect(await journal.history('f2')).toEqual([]);
    expect(await journal.history('nobody')).toEqual([]);
  });
});

describe('the hold evidence', () => {
  test('a hold names at least one surface, and the evidence names the request only when the hold id carries one', async () => {
    const { folder, journal } = fixture();
    await expect(
      journal.quarantine('f1', event(1, { names: [] as unknown as InputQuarantineEvent['names'] })),
    ).rejects.toThrow('a hold needs at least one surface name');
    await journal.quarantine('f1', event(1, { hold: 'not-a-request/1' }));
    const [line] = (folder.raw(HoldsFile) ?? '')
      .trim()
      .split('\n')
      .map(text => JSON.parse(text));
    expect(line).toMatchObject({ hold: 'not-a-request/1', target: { kind: 'terminal', key: 'dev' }, event: 'began' });
    expect(line.request).toBeUndefined();
    await journal.quarantine('f1', event(2));
    expect((folder.raw(HoldsFile) ?? '').includes(`"request":"${REQUEST}"`)).toBe(true);
  });

  test('revealed evidence is not a hold to replay, and sessions are found from the log alone', async () => {
    const { folder, journal } = fixture();
    await journal.quarantine('f1', event(1));
    await journal.quarantine('f2', event(2));
    folder.plant(
      HoldsFile,
      `${folder.raw(HoldsFile) ?? ''}${JSON.stringify({
        format: 1,
        ferret: 'f1',
        hold: `${REQUEST}/9`,
        names: ['dev'],
        at: AT,
        target: { kind: 'terminal', key: 'dev' },
        event: 'revealed',
      })}\n`,
    );
    expect((await journal.quarantines('f1')).map(held => held.hold)).toEqual([`${REQUEST}/1`]);
    expect([...(await journal.quarantineSessions())].sort()).toEqual(['f1', 'f2']);
  });
});
