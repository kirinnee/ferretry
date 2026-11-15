import { describe, expect, it } from 'bun:test';
import type { ConversationNameList } from '../../../../contract/index.ts';
import { workSearchCommandSource } from '../../../../app/search/work-search-commands.ts';

/**
 * The bar rebuilds its sources on every reopen, and each provider's list is kept for the daemon's lifetime. A source
 * that listened to a list and left the listener behind would, after the one read is over, leave one more listener
 * forever with each reopen. These cases reopen the bar against a list that keeps the contract of
 * {@link ConversationNameList} exactly as the two providers do (Projects' `workProjectNamesList`, Ferrets'
 * `askOwnersList`; each has its own suite for it, since Conversation reaches another package only through its
 * contract), after a read that landed and after one that failed, and count what is still listening.
 */

const settle = async () => {
  for (let n = 0; n < 10; n++) await Promise.resolve();
};

/** A name list as the providers keep it: one lazy read, told to the waiting when it lands, nobody kept once it is over. */
const providerList = (read: () => Promise<ReadonlyMap<string, string>>): ConversationNameList => {
  let known: ReadonlyMap<string, string> = new Map();
  let started = false;
  let settled = false;
  const listeners = new Set<() => void>();
  const settleAll = () => {
    settled = true;
    const waiting = [...listeners];
    listeners.clear();
    return waiting;
  };
  return {
    subscribe: listener => {
      if (settled) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settled: () => settled,
    names: () => {
      if (!started) {
        started = true;
        read().then(
          names => {
            known = names;
            for (const listener of settleAll()) listener();
          },
          () => void settleAll(),
        );
      }
      return known;
    },
  };
};

const providers = [
  {
    hook: 'conversation.work-project-names',
    answer: new Map([['p1', 'Project']]),
    hit: { kind: 'card', project: 'p1', standing: 'Doing', id: 'F1' },
  },
  {
    hook: 'conversation.ask-owners',
    answer: new Map([['f1', 'hayden']]),
    hit: { kind: 'ask', standing: 'open', id: 'A1' },
  },
] as const;

/** A list that counts the listeners it was given and has not yet been told to let go of. */
const watched = (list: ConversationNameList) => {
  const count = { active: 0, subscribed: 0 };
  const value: ConversationNameList = {
    names: list.names,
    settled: list.settled,
    subscribe: listener => {
      count.active += 1;
      count.subscribed += 1;
      const stop = list.subscribe(listener);
      let stopped = false;
      return () => {
        if (!stopped) count.active -= 1;
        stopped = true;
        stop();
      };
    },
  };
  return { count, value };
};

describe('S11 reopening the work search leaves nothing listening', () => {
  for (const provider of providers) {
    for (const outcome of ['landed', 'failed'] as const) {
      it(`${provider.hook}: three reopens against a ${outcome} read keep no listener and read once`, async () => {
        let reads = 0;
        const client = {};
        const { count, value } = watched(
          providerList(async () => {
            reads += 1;
            if (outcome === 'failed') throw new Error('offline fixture');
            return provider.answer;
          }),
        );
        // The one read is over before the bar is reopened.
        value.names();
        await settle();

        for (let reopen = 0; reopen < 3; reopen++) {
          let run = () => {};
          const source = workSearchCommandSource(
            {
              daemon: 'fixture',
              client: client as never,
              navigate: () => {},
              screenHref: () => '/fixture',
              changed: () => {},
              appHook: name => (name === provider.hook ? value : undefined),
            },
            {
              schedule: fn => {
                run = fn;
                return () => {};
              },
              port: {
                search: async () => ({
                  hits: [
                    {
                      ...provider.hit,
                      ferret: 'f1',
                      title: 'Fixture',
                      state: 'open',
                      updatedAt: '2026-10-30T10:00:00.000Z',
                      match: { field: 'title', line: 'Fixture' },
                      score: 1,
                    },
                  ],
                  total: 1,
                  indexed: { cards: 1, asks: 1 },
                }),
              } as never,
            },
          );
          source.list('fixture', {});
          run();
          await settle();
          expect(source.list('fixture', {}).entries).toHaveLength(1);
        }

        expect(reads).toBe(1);
        expect(count.active).toBe(0);
        expect(count.subscribed).toBe(0);
      });
    }
  }

  it('a source discarded while the read is still out is let go of when the read is over', async () => {
    let finish = () => {};
    const client = {};
    const { count, value } = watched(
      providerList(
        () =>
          new Promise(resolve => {
            finish = () => resolve(new Map([['f1', 'hayden']]));
          }),
      ),
    );
    let changed = 0;
    let run = () => {};
    const source = workSearchCommandSource(
      {
        daemon: 'fixture',
        client: client as never,
        navigate: () => {},
        screenHref: () => '/fixture',
        changed: () => {
          changed += 1;
        },
        appHook: () => value,
      },
      {
        schedule: fn => {
          run = fn;
          return () => {};
        },
        port: {
          search: async () => ({
            hits: [
              {
                kind: 'ask',
                id: 'A1',
                ferret: 'f1',
                standing: 'open',
                title: 'Fixture',
                state: 'open',
                updatedAt: '2026-10-30T10:00:00.000Z',
                match: { field: 'title', line: 'Fixture' },
                score: 1,
              },
            ],
            total: 1,
            indexed: { cards: 0, asks: 1 },
          }),
        } as never,
      },
    );
    source.list('fixture', {});
    run();
    await settle();
    source.list('fixture', {});
    expect(count.active).toBe(1);
    const before = changed;

    finish();
    await settle();

    expect(count.active).toBe(0);
    expect(changed).toBe(before + 1);
  });
});
