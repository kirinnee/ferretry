import { describe, it } from 'bun:test';
import should from 'should';
import type { AgendaBoardChange } from '../../../../daemon/drafts/lib/agenda-items.ts';
import { AgendaDraftSessions, AgendaItemDraftDiscard } from '../../../../daemon/drafts/lib/index.ts';

const change = (shape: { readonly addressed?: string; readonly open?: string }): AgendaBoardChange =>
  ({
    change: shape.addressed === undefined ? 'replied' : 'answered',
    ...(shape.addressed === undefined ? {} : { addressed: { id: shape.addressed } }),
    ...(shape.open === undefined ? {} : { item: { id: shape.open } }),
  }) as unknown as AgendaBoardChange;

describe('AgendaItemDraftDiscard', () => {
  it('deletes the draft of an item that closed, whichever way it closed', async () => {
    const discarded: string[] = [];
    const observer = new AgendaItemDraftDiscard({
      discard: async (session, item) => void discarded.push(`${session}/${item}`),
    });

    await observer.changed('s1', change({ addressed: 'A4' }));

    should(discarded).deepEqual(['s1/A4']);
  });

  it('keeps the draft of an item that is only replied to (parked), or merely changed', async () => {
    const discarded: string[] = [];
    const observer = new AgendaItemDraftDiscard({
      discard: async (session, item) => void discarded.push(`${session}/${item}`),
    });

    await observer.changed('s1', change({ open: 'A4' }));

    should(discarded).be.empty();
  });

  it('never refuses the board change it is told about', async () => {
    const observer = new AgendaItemDraftDiscard({ discard: async () => await Promise.reject(new Error('disk')) });
    await should(observer.changed('s1', change({ addressed: 'A4' }))).be.fulfilled();
  });
});

describe('AgendaDraftSessions', () => {
  const sessions = (entries: readonly { lifecycle: string; id: string }[] | null) =>
    new AgendaDraftSessions(
      { has: async id => id === 's1' },
      {
        read: async () =>
          entries === null ? null : { entries: entries.map(({ lifecycle, id }) => ({ lifecycle, item: { id } })) },
      },
    );

  it('calls an item open while it is active on the board', async () => {
    const directory = sessions([
      { lifecycle: 'active', id: 'A1' },
      { lifecycle: 'addressed', id: 'A2' },
    ]);
    should(await directory.has('s1')).be.true();
    should(await directory.hasOpenItem('s1', 'A1')).be.true();
    should(await directory.hasOpenItem('s1', 'A2')).be.false();
    should(await directory.hasOpenItem('s1', 'A3')).be.false();
  });

  it('has no open item on a session with no board', async () => {
    should(await sessions(null).hasOpenItem('s1', 'A1')).be.false();
  });
});
