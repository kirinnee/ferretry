import { afterEach, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { deviceStanding, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import type { AskDraft, EntryId, SourceKey } from '../../../contract/index.ts';
import { agendaFilePath } from '../../support/daemon/agenda-state.ts';
import { asksHalf } from '../../support/daemon/asks-half.ts';

const RAISE = {
  action: 'add',
  title: 'Release unblock',
  subject: 'which base branch?',
  why: 'the ticket names two',
  premise: 'A ferret needs the owner.',
  context: 'The work waits on this answer.',
  howToResolve: 'name the branch to target',
  ask: { kind: 'multiple-choice', options: [{ label: 'main' }, { label: 'develop' }] },
} as const;
const ANSWER = { action: 'resolve', id: 'A1', response: { kind: 'multiple-choice', choice: 'main' } } as const;
const BOARD = 'POST /v1/ferrets/:ferretId/agenda';
const F1 = { ferretId: 'f1' };

const draft = (entry: string, ferret: string): AskDraft => ({
  source: 'ferret' as SourceKey,
  ref: {},
  entry: entry as EntryId,
  kind: 'yesno',
  subject: 'Ship it?',
  why: 'The release is ready.',
  raisedBy: { kind: 'ferret', ferret },
  ferret,
});

const halves: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(halves.splice(0).map(async half => await half.close()));
});
async function world() {
  const half = await asksHalf();
  halves.push(half);
  return half;
}

describe('the Asks daemon half over a kernel state folder', () => {
  it("should keep a ferret's ask on that ferret's board, at state/asks/ferrets/<ferret>/agenda.json", async () => {
    // Arrange
    const half = await world();

    // Act
    const raised = await half.call(BOARD, F1, RAISE, ferretStanding('f1' as FerretId));
    const listed = await half.call('GET /v1/ferrets/:ferretId/agenda', F1);

    // Assert
    expect(raised.status).toBe(200);
    expect(listed.json<{ items: { id: string }[] }>().items.map(item => item.id)).toEqual(['A1']);
    const stored = JSON.parse(await readFile(agendaFilePath(half.home, 'f1', 'agenda.json'), 'utf8'));
    expect(stored.version).toBe(1);
  });

  it("should refuse a ferret answering another ferret's ask, and take the owner's answer from a device", async () => {
    // Arrange
    const half = await world();
    await half.call(BOARD, F1, RAISE, ferretStanding('f1' as FerretId));

    // Act
    const byFerret = await half.call(BOARD, F1, ANSWER, ferretStanding('f2' as FerretId));
    const byOwner = await half.call(BOARD, F1, ANSWER, deviceStanding('phone'));

    // Assert
    expect(byFerret.status).toBe(403);
    expect(byOwner.status).toBe(200);
  });

  it("should refuse a ferret raising on another ferret's board", async () => {
    // Arrange
    const half = await world();

    // Act
    const raised = await half.call(BOARD, F1, RAISE, ferretStanding('f2' as FerretId));

    // Assert
    expect(raised.status).toBe(403);
  });

  it('should number asks per ferret through the port, and raise once per (source, entry)', async () => {
    // Arrange
    const half = await world();

    // Act
    const mine = await half.asks.raise(draft('e1', 'f1'));
    const again = await half.asks.raise(draft('e1', 'f1'));
    const theirs = await half.asks.raise(draft('e2', 'f2'));

    // Assert
    expect(again).toEqual(mine);
    expect([mine, theirs].map(ref => `${ref.ferret} ${ref.id}`)).toEqual(['f1 A1', 'f2 A1']);
    expect((await half.asks.get(mine))?.state).toBe('open');
    expect((await half.asks.open({ ferret: 'f2' as FerretId })).map(ask => String(ask.entry))).toEqual(['e2']);
  });

  it("should hand a source back the owner's answer by its obligation, and close what it is asked to", async () => {
    // Arrange
    const half = await world();
    const mine = await half.asks.raise(draft('e1', 'f1'));
    await half.call(BOARD, F1, {
      action: 'resolve',
      id: mine.id,
      response: { kind: 'multiple-choice', choice: 'Yes' },
    });

    // Act
    const answers = await half.asks.answers({ source: 'ferret' as SourceKey, entry: 'e1' as EntryId });
    const other = await half.asks.raise(draft('e2', 'f1'));
    await half.asks.close(other, 'withdrawn');

    // Assert
    expect(answers.map(answer => [answer.ferret, answer.ask, answer.effect, answer.choice])).toEqual([
      ['f1', 'A1', 'choose', 'Yes'],
    ]);
    expect((await half.asks.get(other))?.state).toBe('closed');
  });

  it('should refuse a raise from a source no plugin registers', async () => {
    // Arrange
    const half = await world();

    // Act
    const raised = half.asks.raise({ ...draft('e1', 'f1'), source: 'card' as SourceKey });

    // Assert
    await expect(raised).rejects.toThrow(/no plugin registers the ask source "card"/u);
  });

  it("should hold the owner's answer for a ferret while nothing can type into it, and say it is held", async () => {
    // Arrange
    const half = await world();
    await half.call(BOARD, F1, RAISE, ferretStanding('f1' as FerretId));
    await half.call(BOARD, F1, ANSWER, ownerStanding('ui'));

    // Act
    const sent = await half.call('POST /v1/ferrets/:ferretId/agenda/replies', F1, {});

    // Assert
    expect(sent.status).toBe(200);
  });
});
