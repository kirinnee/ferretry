import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { KernelTaskStore } from '../../../daemon/adapters/store/task-store.ts';
import { BoardService } from '../../../daemon/lib/board/index.ts';
import { GitHubWatcher, UnfiledRefiler } from '../../../daemon/lib/github/index.ts';
import { KeyedSerial } from '../../../daemon/lib/lanes/index.ts';
import manifest from '../../../manifest.ts';
import { boardTask, FakeLanes, ferretActor, lanes, NOW, PROJECT, world } from '../../unit/board/support.ts';
import { answer, prNode, prUrl } from '../../unit/github/support.ts';

/**
 * The stall family (a live board of ~3,600 cards answered /healthz over 250 ms while the watcher wrote cards): the
 * daemon is one thread, so what matters is the longest stretch the tick runs WITHOUT giving the event loop back.
 * The cards are stored by the real `KernelCardStore` (its schema parse and per-card serial sections included) and every
 * stub below yields to the loop once per call, as the real file, `gh` and Asks calls do, so a gap the sampler sees is
 * one synchronous slice of the tick's own work, measured as the CPU it burned (see the sampler).
 */
const MAX_SLICE_MS = 100;
const TASKS = 3_600;
const REPOSITORIES = 8;
const HISTORY = 30;

const file = (name: string) => manifest.data.state.find(candidate => candidate.name === name) as never;
/** The CPU time this process has used so far (user + system), in ms: what a stretch of work cost, not how long a busy host took to run it. */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
const yieldToLoop = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
};

const repositoryOf = (index: number): string => `owner/repo${String(index % REPOSITORIES)}`;
const numberOf = (index: number): number => Math.floor(index / REPOSITORIES) + 1;

const stored = (index: number) => {
  const id = `F${String(index + 1)}`;
  const repo = repositoryOf(index);
  const number = numberOf(index);
  return boardTask({
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
  for (let number = 1; number <= numberOf(TASKS); number += 1) prs[number] = prNode(number, { repo });
  return answer({ prs });
};

describe('the watcher tick on a 3,600-card board', () => {
  it('should never run one synchronous slice of 100 ms or more while it writes every card', async () => {
    const state = new MemoryStateFolder().port([file('cards'), file('counters')]);
    const store = new KernelTaskStore(state, { cards: file('cards'), counters: file('counters') }, new KeyedSerial(), {
      warn: () => undefined,
    });
    for (let index = 0; index < TASKS; index += 1) {
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

    // The perf tier runs every file in ONE bun process (the sibling `watcher-slices.test.ts` runs just before this one),
    // so the heap holds what earlier files left. A major garbage collection is a stop-the-world pause proportional to
    // that heap, and one that falls inside the tick is charged to the tick although the tick did not cause it (CI,
    // run 43902827736: 150 ms against the 100 ms bound; here, a heap freshly grown by 2.5 M small objects: 179-426 ms
    // for the same tick, 25-35 ms once collected first). Collect first, outside the measured window, so the window
    // holds only the tick's own synchronous work. A tick that really holds the loop still fails: see the commit.
    Bun.gc(true);

    // A slice is measured in CPU time, not wall time: the tick's own work is what the code controls, and wall time also
    // counts every moment a loaded shared runner took the CPU away (here, 96 busy processes on 32 cores stretched a
    // ~30 ms slice to 136 ms with the same code). A slice that really holds the loop burns CPU for the whole gap, so it
    // still fails; a preempted one does not.
    let longestSlice = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const from = cpuMs();
        await yieldToLoop();
        longestSlice = Math.max(longestSlice, cpuMs() - from);
      }
    })();
    const report = await watcher.tick();
    sampling = false;
    await sampler;

    should(report.written.length).equal(TASKS);
    should(longestSlice).be.below(MAX_SLICE_MS);
  }, 120_000);
});
