import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { KernelCardStore } from '../../../daemon/adapters/store/card-store.ts';
import { BoardService } from '../../../daemon/lib/board/index.ts';
import { GitHubWatcher, UnfiledRefiler } from '../../../daemon/lib/github/index.ts';
import { KeyedSerial } from '../../../daemon/lib/lanes/index.ts';
import manifest from '../../../manifest.ts';
import { card, FakeLanes, ferretActor, lanes, NOW, PROJECT, world } from '../board/support.ts';
import { answer, prNode, prUrl } from './support.ts';

/**
 * The stall family (a live board of ~3,600 cards answered /healthz over 250 ms while the watcher wrote cards): the
 * daemon is one thread, so what matters is the longest stretch the tick runs WITHOUT giving the event loop back.
 * The cards are stored by the real `KernelCardStore` (its schema parse and per-card serial sections included) and every
 * stub below yields to the loop once per call, as the real file, `gh` and Asks calls do, so a gap the sampler sees is
 * one synchronous slice of the tick's own work.
 */
const MAX_SLICE_MS = 100;
const CARDS = 3_600;
const REPOSITORIES = 8;
const HISTORY = 30;

const file = (name: string) => manifest.data.state.find(candidate => candidate.name === name) as never;
const yieldToLoop = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
};

const repositoryOf = (index: number): string => `owner/repo${String(index % REPOSITORIES)}`;
const numberOf = (index: number): number => Math.floor(index / REPOSITORIES) + 1;

const stored = (index: number) => {
  const id = `F${String(index + 1)}`;
  const repo = repositoryOf(index);
  const number = numberOf(index);
  return card({
    id,
    laneId: 'implement',
    workflow: 'quick',
    history: Array.from({ length: HISTORY }, (_, seq) =>
      seq === 0
        ? { seq: 1, at: NOW, actor: ferretActor('lead'), type: 'created' as const, laneId: 'implement' }
        : {
            seq: seq + 1,
            at: NOW,
            actor: ferretActor('lead'),
            type: 'note' as const,
            text: `note ${String(seq)} on ${id}`,
          },
    ),
    links: {
      prs: [
        {
          url: prUrl(number, repo),
          number,
          repo,
          state: 'unknown',
          draft: false,
          checks: 'none',
          mergedAt: null,
          mergeSha: null,
          releasedIn: null,
          polledAt: null,
        },
      ],
      branch: null,
      commits: [],
      docs: [],
    },
  });
};

/** GitHub's answer for one repository: every PR open, which every card's `unknown` link learns from, so EVERY card writes. */
const everyPullRequest = (repo: string): string => {
  const prs: Record<number, unknown> = {};
  for (let number = 1; number <= numberOf(CARDS); number += 1) prs[number] = prNode(number, { repo });
  return answer({ prs });
};

describe('the watcher tick on a 3,600-card board', () => {
  it('should never run one synchronous slice of 100 ms or more while it writes every card', async () => {
    const state = new MemoryStateFolder().port([file('cards'), file('counters')]);
    const store = new KernelCardStore(state, { cards: file('cards'), counters: file('counters') }, new KeyedSerial(), {
      warn: () => undefined,
    });
    for (let index = 0; index < CARDS; index += 1) {
      const task = stored(index);
      await store.write(task.id, async () => ({ task, result: null }));
    }
    const boardLanes = new FakeLanes(new Map([[PROJECT, lanes(PROJECT)]]));
    const service = new BoardService(world({ store: store as never, lanes: boardLanes }));
    const board = {
      snapshot: async () => {
        await yieldToLoop();
        return await service.snapshot();
      },
      recordPullRequests: async (...args: Parameters<BoardService['recordPullRequests']>) => {
        await yieldToLoop();
        return await service.recordPullRequests(...args);
      },
      act: async (...args: Parameters<BoardService['act']>) => await service.act(...args),
    };
    const gh = {
      run: async (args: readonly string[]) => {
        await yieldToLoop();
        const owner = args.find(arg => arg.startsWith('owner='))?.slice('owner='.length);
        const name = args.find(arg => arg.startsWith('name='))?.slice('name='.length);
        return { kind: 'ok' as const, stdout: everyPullRequest(`${String(owner)}/${String(name)}`) };
      },
    };
    const copies = { repositoryOf: async () => null, branchOf: async () => null };
    const projects = { projects: async () => [] };
    const diagnostics = { warn: () => undefined };
    const now = () => NOW;
    const watcher = new GitHubWatcher({
      board: board as never,
      gh,
      copies,
      sessions: { cwdOf: async () => null },
      projects,
      transcripts: { tail: async () => ({ kind: 'unresolved' }) },
      nudges: { send: async () => undefined },
      clock: { now, random: () => 0.5 },
      diagnostics,
      unfiled: new UnfiledRefiler({
        board: board as never,
        sessions: { boardOf: async () => null },
        lanes: { laneSet: async project => await boardLanes.laneSet(project), propose: async () => null },
        projects,
        copies,
        clock: { now },
        diagnostics,
      }),
      version: '4.114.0',
    });

    let longestSlice = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const from = performance.now();
        await yieldToLoop();
        longestSlice = Math.max(longestSlice, performance.now() - from);
      }
    })();
    const report = await watcher.tick();
    sampling = false;
    await sampler;

    should(report.written.length).equal(CARDS);
    should(longestSlice).be.below(MAX_SLICE_MS);
  }, 120_000);
});
