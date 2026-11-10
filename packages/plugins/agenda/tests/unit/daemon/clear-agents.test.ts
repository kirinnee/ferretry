import { describe, expect, it } from 'bun:test';
import type { AskId, AskRef, AsksApi, AskSummary } from '@ferretry/core-asks/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { AgendaAgentClearer } from '../../../daemon/lib/clear-agents.ts';

const ask = (id: string, source = 'agent-raised'): AskSummary => ({ id: id as AskId, source }) as unknown as AskSummary;

interface Board {
  readonly asks?: readonly AskSummary[];
  readonly unreadable?: true;
}

const build = (boards: Record<string, Board>, refuse: readonly string[] = []) => {
  const closed: Array<{ ferret: string; id: string; reason: string }> = [];
  const asks: Pick<AsksApi, 'open' | 'close'> = {
    open: async filter => {
      const board = boards[String(filter.ferret)];
      if (board === undefined || board.unreadable === true) throw new Error('unreadable');
      return board.asks ?? [];
    },
    close: async (ref: AskRef, reason) => {
      if (refuse.includes(String(ref.id))) throw new Error('refused');
      closed.push({ ferret: String(ref.ferret), id: String(ref.id), reason: String(reason) });
    },
  };
  const agents = { agentFerrets: async () => Object.keys(boards) as FerretId[] };
  return { clearer: new AgendaAgentClearer(agents, asks), closed };
};

describe('AgendaAgentClearer', () => {
  const boards: Record<string, Board> = {
    a: { asks: [ask('A1'), ask('A2'), ask('C1', 'card')] },
    b: { asks: [ask('B1')] },
    quiet: { asks: [] },
    broken: { unreadable: true },
    cardsOnly: { asks: [ask('C2', 'card')] },
  };

  it('counts what a clear would dismiss without changing anything, never counting a card’s ask', async () => {
    const { clearer, closed } = build(boards);
    expect(await clearer.preview()).toEqual({ cleared: 3, ferrets: 2 });
    expect(closed).toEqual([]);
  });

  it('dismisses every open ask of the agent ferrets as the owner, and counts what actually went', async () => {
    const { clearer, closed } = build(boards, ['A2']);
    expect(await clearer.clear()).toEqual({ cleared: 2, ferrets: 2 });
    expect(closed).toEqual([
      { ferret: 'a', id: 'A1', reason: 'dismissed' },
      { ferret: 'b', id: 'B1', reason: 'dismissed' },
    ]);
  });

  it('counts no ferret whose every close was refused', async () => {
    const { clearer } = build({ a: { asks: [ask('A1')] } }, ['A1']);
    expect(await clearer.clear()).toEqual({ cleared: 0, ferrets: 0 });
  });
});
