import { describe, expect, test } from 'bun:test';
import type { BoardServerQuery } from '../../src/lib/board-model.ts';
import { useProjectCards } from '../../src/hooks/use-ferret-cards.ts';
import { DaemonBoardStore } from '../../src/lib/board-store.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { boardAnswer, fakeEnvironment, fakePort, laneSetFor, originCard, PROJECT } from './board-support.ts';

const daemon = daemonConnection({ daemonId: 'picker-daemon', baseUrl: 'https://picker.example.test', deviceId: 't' });
const SESSION = 'session-a';

const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
};

type Cards = ReturnType<typeof useProjectCards>;

const observe = async (projectId: string | null) => {
  const queries: BoardServerQuery[] = [];
  const store = new DaemonBoardStore(
    fakePort({
      board: async (_connection, query) => {
        queries.push(query);
        return boardAnswer(
          [
            originCard('F1', 'human', null, { owner: SESSION }),
            originCard('F2', 'human', null, { owner: 'someone-else', assignee: 'another-ferret' }),
            originCard('F3', 'human', null, { owner: 'lead' }),
            originCard('F4', 'agent', { id: 'F2' }, { owner: 'lead' }),
          ],
          { projectId: PROJECT, laneSet: laneSetFor() },
        );
      },
    }),
    fakeEnvironment(),
  );
  let latest: Cards | undefined;
  const Probe = () => {
    latest = useProjectCards(store, daemon, SESSION, projectId);
    return null;
  };
  const view = render(<Probe />);
  await settle();
  return {
    queries,
    latest: () => {
      if (latest === undefined) throw new Error('probe never rendered');
      return latest;
    },
    unmount: () => run(() => view.unmount()),
  };
};

describe('useProjectCards', () => {
  test('reads the whole project, so cards another ferret holds are offered too', async () => {
    const probe = await observe(PROJECT);
    try {
      expect(probe.queries.map(query => [query.project, query.ferret, query.state])).toEqual([[PROJECT, null, 'all']]);
      expect(probe.latest().state).toBe('ready');
      expect(
        probe
          .latest()
          .cards.map(card => card.id)
          .sort(),
      ).toEqual(['F1', 'F2', 'F3', 'F4']);
    } finally {
      probe.unmount();
    }
  });

  test('says which cards a human asked for from the daemon’s own origin', async () => {
    const probe = await observe(PROJECT);
    try {
      const asked = new Map(probe.latest().cards.map(card => [card.id, card.agentAsked]));
      expect([...asked]).toEqual(
        expect.arrayContaining([
          ['F1', false],
          ['F2', false],
          ['F3', false],
          ['F4', true],
        ]),
      );
    } finally {
      probe.unmount();
    }
  });

  test('reads nothing for a session with no project', async () => {
    const probe = await observe(null);
    try {
      expect(probe.queries).toEqual([]);
      expect(probe.latest().state).toBe('loading');
      expect(probe.latest().wait()).toBeUndefined();
    } finally {
      probe.unmount();
    }
  });
});
