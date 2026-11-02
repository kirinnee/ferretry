import { describe, it } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import should from 'should';
import { ThreadGateObserver, threadCardOf } from '../../../src/lib/board/thread-gate-observer.ts';

const item = (extra: Record<string, unknown> = {}): AgendaItem =>
  ({ id: 'A1', raisedBy: 'agent', task: { id: 'F1' }, ...extra }) as AgendaItem;

describe('threadCardOf', () => {
  it('names the card of an agent-raised thread', () => {
    should(threadCardOf(item())).equal('F1');
  });

  it('is nothing for no item, no card, a gate item, a notice or a daemon-raised item', () => {
    should(threadCardOf(undefined)).be.undefined();
    should(threadCardOf(item({ task: undefined }))).be.undefined();
    should(threadCardOf(item({ task: null }))).be.undefined();
    should(threadCardOf(item({ gate: {} }))).be.undefined();
    should(threadCardOf(item({ notice: true }))).be.undefined();
    should(threadCardOf(item({ raisedBy: 'daemon' }))).be.undefined();
  });
});

describe('ThreadGateObserver', () => {
  const run = async (change: Record<string, unknown>, fails = false) => {
    const written: string[] = [];
    const observer = new ThreadGateObserver({
      written: async id => {
        written.push(id);
        if (fails) throw new Error('boom');
      },
    });
    await observer.changed('s1', change as never);
    await new Promise(resolve => setTimeout(resolve, 0));
    return written;
  };

  it('has the gates look again at the card of the thread that changed', async () => {
    should(await run({ item: item() })).deepEqual(['F1']);
  });

  it('reads the card from the addressed item when the item is gone (a resolved thread)', async () => {
    should(await run({ item: undefined, addressed: item({ task: { id: 'F7' } }) })).deepEqual(['F7']);
  });

  it('ignores a change that is no thread of a card, and a failing look never rejects', async () => {
    should(await run({ item: item({ task: undefined }) })).deepEqual([]);
    should(await run({ item: item() }, true)).deepEqual(['F1']);
  });
});
