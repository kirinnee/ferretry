import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { AskDraft, AskId, AskSourceSpec, AskRef, EntryId, SourceKey } from '../../../contract/index.ts';
import { agendaLedgerDocument, applyAgendaCommandToSession } from '../../../daemon/lib/agenda/state-machine.ts';
import { agendaFilePath } from '../../support/daemon/agenda-state.ts';
import { MACHINE_AGENDA_ID } from '../../../daemon/lib/protocol/agenda.ts';
import { asksHalf } from '../../support/daemon/asks-half.ts';

const BOARD = 'POST /v1/ferrets/:ferretId/agenda';
const halves: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(halves.splice(0).map(async half => await half.close()));
});
async function world(providers: Record<string, unknown> = {}) {
  const half = await asksHalf(providers);
  halves.push(half);
  return half;
}

const draft = (entry: string, ferret: string, extra: Partial<AskDraft> = {}): AskDraft => ({
  source: 'ferret' as SourceKey,
  ref: {},
  entry: entry as EntryId,
  kind: 'yesno',
  subject: 'Ship it?',
  why: 'The release is ready.',
  raisedBy: { kind: 'ferret', ferret },
  ferret,
  ...extra,
});

const answer = (half: Awaited<ReturnType<typeof world>>, ref: AskRef, response: unknown, note?: string) =>
  half.call(
    BOARD,
    { ferretId: ref.ferret },
    { action: 'resolve', id: ref.id, response, ...(note === undefined ? {} : { note }) },
    ownerStanding('ui'),
  );

describe('raising through the Asks port', () => {
  it('should carry the options, the context and the reason a source gave, on the ferret’s board', async () => {
    // Arrange
    const half = await world();

    // Act
    const ref = await half.asks.raise(
      draft('e1', 'f1', {
        kind: 'choice',
        options: [{ label: 'main' }, { label: 'develop' }],
        context: 'Two branches carry the fix.',
        howToResolve: 'Pick the branch to target.',
      }),
    );
    const [snapshot] = await half.asks.snapshots({ ferret: 'f1' });

    // Assert
    expect(snapshot?.items[0]).toMatchObject({
      id: ref.id,
      kind: 'choice',
      context: 'Two branches carry the fix.',
      howToResolve: 'Pick the branch to target.',
      ask: { kind: 'multiple-choice', options: [{ label: 'main' }, { label: 'develop' }] },
    });
  });

  it('should use the reason as the way to resolve when the source gave none', async () => {
    // Arrange
    const half = await world();

    // Act
    await half.asks.raise(draft('e1', 'f1'));
    const [snapshot] = await half.asks.snapshots({ ferret: 'f1' });

    // Assert
    expect(snapshot?.items[0]?.howToResolve).toBe('The release is ready.');
  });

  it('should mark a blocking ask as blocking now, and a blocking notice as one that pings', async () => {
    // Arrange
    const half = await world();

    // Act
    const ask = await half.asks.raise(draft('e1', 'f1', { blocking: true }));
    const notice = await half.asks.notify({ ...draft('n1', 'f1', { blocking: true }), kind: undefined } as never);
    const quiet = await half.asks.notify({ ...draft('n2', 'f1'), kind: undefined } as never);
    const open = await half.asks.open({ ferret: 'f1' as FerretId });

    // Assert
    const byId = new Map(open.map(each => [each.id, each]));
    expect(byId.get(ask.id)?.blocking).toBe(true);
    expect(byId.get(notice.id)).toMatchObject({ kind: 'notice', blocking: true });
    expect(byId.get(quiet.id)?.blocking).toBeUndefined();
  });

  it('should refuse a raise that names no ferret board', async () => {
    // Arrange
    const half = await world();

    // Act
    const raised = half.asks.raise(draft('e1', 'f1', { ferret: undefined, raisedBy: { kind: 'daemon' } }));

    // Assert
    await expect(raised).rejects.toThrow("an ask lives on a ferret's board, and this one names no ferret");
  });

  it('should take the board from the ferret that raised it when the draft names no other', async () => {
    // Arrange
    const half = await world();

    // Act
    const ref = await half.asks.raise(draft('e1', 'f7', { ferret: undefined }));

    // Assert
    expect(ref.ferret).toBe('f7');
  });

  it('should refuse a ref its source cannot read, and one for a source that is off', async () => {
    // Arrange
    const spec: AskSourceSpec = { schema: z.strictObject({ card: z.string() }), title: 'Card {card}', form: false };
    const half = await world({ 'ask.sources:card': spec });

    // Act
    await expect(
      half.asks.raise(draft('e1', 'f1', { source: 'card' as SourceKey, ref: { nope: 1 } })),
    ).rejects.toThrow();
    const fine = await half.asks.raise(draft('e2', 'f1', { source: 'card' as SourceKey, ref: { card: 'F1' } }));

    // Assert
    expect(String(fine.id)).toBe('A1');
    await expect(half.asks.raise(draft('e3', 'f1', { source: 'sign-in' as SourceKey }))).rejects.toThrow(
      'no plugin registers the ask source "sign-in"',
    );
  });

  it('should answer a raise retried on another board with the ask it already made, even with its source off', async () => {
    // Arrange
    const spec: AskSourceSpec = { schema: z.strictObject({}), title: 'Card', form: false };
    const on = await world({ 'ask.sources:card': spec });
    const first = await on.asks.raise(draft('e1', 'f1', { source: 'card' as SourceKey }));
    const off = await asksHalf({}, { home: on.home });
    halves.push(off);

    // Act
    const again = await off.asks.raise(draft('e1', 'f2', { source: 'card' as SourceKey }));

    // Assert
    expect(again).toEqual(first);
  });

  it('should refuse the board’s own sentence when the engine refuses the raise', async () => {
    // Arrange
    const half = await world();

    // Act
    const raised = half.asks.raise(draft('e1', '../escape'));

    // Assert
    await expect(raised).rejects.toThrow('not a valid agenda session id');
  });
});

describe('reading asks through the Asks port', () => {
  it('should list open, answered and closed asks apart, and filter by source, entry and ferret', async () => {
    // Arrange
    const half = await world();
    const answered = await half.asks.raise(draft('e1', 'f1'));
    const closed = await half.asks.raise(draft('e2', 'f1'));
    const open = await half.asks.raise(draft('e3', 'f2'));
    await answer(half, answered, { kind: 'multiple-choice', choice: 'Yes' });
    await half.asks.close(closed, 'withdrawn');

    // Act
    const states = await Promise.all(
      (['open', 'answered', 'closed'] as const).map(async state =>
        (await half.asks.open({ state })).map(each => `${each.ferret}/${each.id}`),
      ),
    );
    const byEntry = await half.asks.open({ state: 'closed', entry: 'e2' as EntryId });
    const bySource = await half.asks.open({ source: 'daemon' as SourceKey });
    const byFerret = await half.asks.open({ ferret: 'f2' as FerretId });

    // Assert
    expect(states).toEqual([['f2/A1'], ['f1/A1'], ['f1/A2']]);
    expect(byEntry.map(each => each.id)).toEqual([closed.id]);
    expect(bySource).toEqual([]);
    expect(byFerret.map(each => each.id)).toEqual([open.id]);
  });

  it('should get an open ask, a closed one, and say nothing of one that does not exist', async () => {
    // Arrange
    const half = await world();
    const open = await half.asks.raise(draft('e1', 'f1'));
    const closed = await half.asks.raise(draft('e2', 'f1'));
    await half.asks.close(closed, 'answered');

    // Assert
    expect((await half.asks.get(open))?.state).toBe('open');
    expect((await half.asks.get(closed))?.state).toBe('closed');
    expect(await half.asks.get({ ferret: 'f1', id: 'A9' as never })).toBeUndefined();
    expect(await half.asks.get({ ferret: '../escape', id: 'A1' as never })).toBeUndefined();
  });

  it('should flag an ask whose source plugin is off, and not one whose source is built in', async () => {
    // Arrange
    const spec: AskSourceSpec = { schema: z.strictObject({}), title: 'Card', form: false };
    const on = await world({ 'ask.sources:card': spec });
    await on.asks.raise(draft('e1', 'f1', { source: 'card' as SourceKey }));
    await on.asks.raise(draft('e2', 'f1'));
    const off = await asksHalf({}, { home: on.home });
    halves.push(off);

    // Act
    const open = await off.asks.open({ ferret: 'f1' as FerretId });

    // Assert
    expect(open.map(each => [String(each.source), each.sourceUnavailable])).toEqual([
      ['card', true],
      ['ferret', undefined],
    ]);
  });

  it('should show a ferret’s own ask as a task with its own id as the entry', async () => {
    // Arrange
    const half = await world();
    await half.call(
      BOARD,
      { ferretId: 'f1' },
      {
        action: 'add',
        subject: 'which base branch?',
        why: 'the ticket names two',
        premise: 'A ferret needs the owner.',
        context: 'The work waits on this answer.',
        howToResolve: 'name the branch to target',
        ask: { kind: 'open-question' },
      },
      ferretStanding('f1' as FerretId),
    );

    // Act
    const [ask] = await half.asks.open({ ferret: 'f1' as FerretId });

    // Assert
    expect(ask).toMatchObject({ source: 'ferret', entry: 'A1', raisedBy: { kind: 'ferret', ferret: 'f1' } });
  });

  it('should read one board or every board', async () => {
    // Arrange
    const half = await world();
    await half.asks.raise(draft('e1', 'f1'));
    await half.asks.raise(draft('e2', 'f2'));

    // Act
    const everyone = await half.asks.snapshots();
    const one = await half.asks.snapshots({ ferret: 'f2' });
    const empty = await half.asks.snapshots({ ferret: 'f3' });
    const bad = half.asks.snapshots({ ferret: '../escape' });

    // Assert
    expect(everyone.map(board => board.sessionId).toSorted()).toEqual(['f1', 'f2']);
    expect(one.map(board => board.count)).toEqual([1]);
    expect(empty.map(board => board.count)).toEqual([0]);
    await expect(bad).rejects.toMatchObject({ name: 'AskOwnerActionError', code: 'invalid' });
  });
});

describe('answers read back through the Asks port', () => {
  const kinds: readonly (readonly [string, Partial<AskDraft>, unknown, string, Record<string, unknown>])[] = [
    ['a pick', { kind: 'yesno' }, { kind: 'multiple-choice', choice: 'No' }, 'choose', { choice: 'No' }],
    ['an approval', { kind: 'permission' }, { kind: 'permission', decision: 'approve' }, 'approve', {}],
    ['a rejection', { kind: 'permission' }, { kind: 'permission', decision: 'reject' }, 'reject', {}],
    ['a good review', { kind: 'review' }, { kind: 'answer-review', verdict: 'good' }, 'good', {}],
    [
      'a review asking to clarify',
      { kind: 'review' },
      { kind: 'answer-review', verdict: 'clarify', clarification: 'Which region?' },
      'clarify',
      { text: 'Which region?' },
    ],
    ['written words', { kind: 'reply' }, { kind: 'open-question', answer: 'eu-west' }, 'clarify', { text: 'eu-west' }],
    [
      'words instead of the options',
      { kind: 'yesno' },
      { kind: 'other', answer: 'Neither, ask again tomorrow' },
      'clarify',
      { text: 'Neither, ask again tomorrow' },
    ],
  ];

  for (const [name, extra, response, effect, expected] of kinds) {
    it(`should read ${name} as the effect ${effect}`, async () => {
      // Arrange
      const half = await world();
      const ref = await half.asks.raise(draft('e1', 'f1', extra));
      await answer(half, ref, response);

      // Act
      const answers = await half.asks.answers({ source: 'ferret' as SourceKey });

      // Assert
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({
        ferret: 'f1',
        ask: ref.id,
        source: 'ferret',
        effect,
        by: { kind: 'host' },
        ...expected,
      });
    });
  }

  it('should read the owner’s note as the text of a plain done, and a bare done as done', async () => {
    // Arrange
    const half = await world();
    const withNote = await half.asks.raise(draft('e1', 'f1', { kind: 'task' }));
    const bare = await half.asks.raise(draft('e2', 'f1', { kind: 'task' }));
    const dismissed = await half.asks.raise(draft('e3', 'f1', { kind: 'task' }));
    await half.call(
      BOARD,
      { ferretId: 'f1' },
      { action: 'resolve', id: withNote.id, note: 'shipped it' },
      ownerStanding('ui'),
    );
    await half.call(BOARD, { ferretId: 'f1' }, { action: 'resolve', id: bare.id }, ownerStanding('ui'));
    await half.call(BOARD, { ferretId: 'f1' }, { action: 'dismiss', id: dismissed.id }, ownerStanding('ui'));

    // Act
    const answers = await half.asks.answers({ source: 'ferret' as SourceKey });

    // Assert
    expect(answers.map(each => [each.entry, each.effect, each.text])).toEqual([
      ['e1', 'done', 'shipped it'],
      ['e2', 'done', undefined],
      ['e3', 'dismiss', undefined],
    ]);
  });

  it('should filter answers by entry and by the time after which they were given', async () => {
    // Arrange
    const half = await world();
    const first = await half.asks.raise(draft('e1', 'f1'));
    const second = await half.asks.raise(draft('e2', 'f1'));
    await answer(half, first, { kind: 'multiple-choice', choice: 'Yes' });
    half.clock.advance?.(60_000);
    await answer(half, second, { kind: 'multiple-choice', choice: 'No' });

    // Act
    const all = await half.asks.answers({ source: 'ferret' as SourceKey });
    const entry = await half.asks.answers({ source: 'ferret' as SourceKey, entry: 'e2' as EntryId });
    const since = await half.asks.answers({ source: 'ferret' as SourceKey }, String(all[0]?.at));

    // Assert
    expect(entry.map(each => each.ask)).toEqual([second.id]);
    expect(since.map(each => each.ask)).toEqual(all.filter(each => each.at > (all[0]?.at ?? '')).map(each => each.ask));
  });

  it('should name an answer the same way each time it is read', async () => {
    // Arrange
    const half = await world();
    const ref = await half.asks.raise(draft('e1', 'f1'));
    await answer(half, ref, { kind: 'multiple-choice', choice: 'Yes' });

    // Act
    const first = await half.asks.answers({ source: 'ferret' as SourceKey });
    const second = await half.asks.answers({ source: 'ferret' as SourceKey });

    // Assert
    expect(first[0]?.id).toMatch(/^an_[0-9a-f]{24}$/u);
    expect(second[0]?.id).toBe(first[0]?.id);
  });
});

describe('closing through the Asks port', () => {
  it('should resolve an answered ask and dismiss a withdrawn one, with the reason as the note', async () => {
    // Arrange
    const half = await world();
    const answered = await half.asks.raise(draft('e1', 'f1'));
    const withdrawn = await half.asks.raise(draft('e2', 'f1'));

    // Act
    await half.asks.close(answered, 'answered');
    await half.asks.close(withdrawn, 'withdrawn');
    const [snapshot] = await half.asks.snapshots({ ferret: 'f1' });

    // Assert
    expect(snapshot?.resolved.map(each => [each.id, each.disposition, each.resolutionNote])).toEqual([
      ['A1', 'done', 'closed: answered'],
      ['A2', 'dismissed', 'closed: withdrawn'],
    ]);
  });

  it('should treat closing an ask that is gone as done, and refuse any other refusal of the engine', async () => {
    // Arrange
    const half = await world();

    // Act
    await expect(half.asks.close({ ferret: 'f1', id: 'A7' as never }, 'withdrawn')).resolves.toBeUndefined();

    // Assert
    await expect(half.asks.close({ ferret: '../escape', id: 'A1' as never }, 'withdrawn')).rejects.toThrow(
      'not a valid agenda session id',
    );
  });
});

describe('the owner’s actions on the machine agenda through the Asks port', () => {
  const machine = async (half: Awaited<ReturnType<typeof world>>, entry: string) =>
    await half.asks.raise(draft(entry, MACHINE_AGENDA_ID, { kind: 'task' }));
  const ref = (id: string) => ({ ferret: MACHINE_AGENDA_ID, id: id as AskId });

  it('should resolve, dismiss, snooze and wake an item on it', async () => {
    // Arrange
    const half = await world();
    const a = await machine(half, 'm1');
    const b = await machine(half, 'm2');
    const c = await machine(half, 'm3');

    // Act
    const resolved = await half.asks.ownerAction({ action: 'resolve', ref: ref(a.id), note: 'handled' });
    const dismissed = await half.asks.ownerAction({ action: 'dismiss', ref: ref(b.id) });
    const snoozed = await half.asks.ownerAction({
      action: 'snooze',
      ref: ref(c.id),
      until: new Date(Date.now() + 3_600_000).toISOString() as never,
    });
    const woken = await half.asks.ownerAction({ action: 'unsnooze', ref: ref(c.id) });

    // Assert
    expect(resolved.resolved.map(each => [each.id, each.resolutionNote])).toEqual([[a.id, 'handled']]);
    expect(dismissed.resolved.map(each => each.id).toSorted()).toEqual([a.id, b.id].toSorted());
    expect(snoozed.items.find(each => each.id === c.id)?.parked?.reason).toBe('snoozed');
    expect(woken.items.find(each => each.id === c.id)?.parked).toBeUndefined();
  });

  it('should say why the engine refused, and leave a ferret’s board to its own route', async () => {
    // Arrange
    const half = await world();
    const mine = await half.asks.raise(draft('e1', 'f1'));

    // Act
    // Assert
    await expect(half.asks.ownerAction({ action: 'resolve', ref: ref('A9') })).rejects.toMatchObject({
      name: 'AskOwnerActionError',
      code: 'not-found',
    });
    await expect(half.asks.ownerAction({ action: 'dismiss', ref: mine })).rejects.toMatchObject({
      name: 'AskOwnerActionError',
      code: 'forbidden',
      message: 'these owner actions belong to the machine agenda',
    });
  });
});

describe('asks the owner raised themselves, and answers that carry form values', () => {
  it('should show an ask the owner added as the owner’s own', async () => {
    // Arrange
    const half = await world();
    await half.call(
      BOARD,
      { ferretId: 'f1' },
      {
        action: 'add',
        title: 'Remember',
        subject: 'Ask the team about the freeze',
        why: 'I keep forgetting.',
        premise: 'There may be a freeze.',
        context: 'It affects the release.',
        howToResolve: 'Ask them.',
        ask: { kind: 'open-question' },
      },
      ownerStanding('ui'),
    );

    // Act
    const [mine] = await half.asks.open({ ferret: 'f1' as FerretId });

    // Assert
    expect(mine?.raisedBy).toEqual({ kind: 'owner' });
  });

  it('should hand a source the values of a form as one text per field', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'asks-port-form-'));
    const raised = applyAgendaCommandToSession(null, 'f1', {
      action: 'raise',
      actor: { kind: 'daemon', cause: 'system' },
      request: {
        source: 'question',
        sourceRef: 'ask:ferret:form1',
        kind: 'form',
        subject: 'Where do we deploy?',
        why: 'The release waits.',
        context: 'It changes the public service.',
        premise: 'A release is ready.',
        howToResolve: 'Fill the form in.',
        ask: { kind: 'open-question' },
        fields: [
          { id: 'region', type: 'one', label: 'Region?', options: [{ label: 'EU' }, { label: 'US' }] },
          { id: 'zones', type: 'many', label: 'Zones?', options: [{ label: 'a' }, { label: 'b' }] },
          { id: 'note', type: 'text', label: 'Anything else?' },
        ],
      },
      at: '2026-11-06T09:00:00.000Z',
    });
    if (!raised.ok) throw new Error(raised.error.message);
    const file = agendaFilePath(root, 'f1', 'agenda.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, agendaLedgerDocument(raised.ledger));
    const half = await asksHalf({}, { home: root });
    halves.push(half);

    // Act
    const response = await half.call(
      BOARD,
      { ferretId: 'f1' },
      {
        action: 'resolve',
        id: 'A1',
        response: {
          kind: 'form',
          answers: [
            { id: 'region', picked: 'EU' },
            { id: 'zones', picked: ['a', 'b'] },
          ],
        },
      },
      ownerStanding('ui'),
    );
    const [recorded] = await half.asks.answers({ source: 'ferret' as SourceKey, entry: 'form1' as EntryId });

    // Assert
    expect(response.status).toBe(200);
    expect(recorded).toMatchObject({ effect: 'clarify', values: { region: 'EU', zones: 'a, b' } });
  });
});
