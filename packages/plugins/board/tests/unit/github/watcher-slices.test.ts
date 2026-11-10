import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import type { Card, PrLink } from '../../../contract/index.ts';
import { KernelCardStore } from '../../../daemon/adapters/store/card-store.ts';
import { BoardService } from '../../../daemon/lib/board/index.ts';
import { GitHubWatcher, type GitHubWatcherPorts, UnfiledRefiler } from '../../../daemon/lib/github/index.ts';
import { KeyedSerial } from '../../../daemon/lib/lanes/index.ts';
import manifest from '../../../manifest.ts';
import { card, FakeLanes, lanes, NOW, PROJECT, world } from '../board/support.ts';
import { answer, prNode, prUrl, REPO } from './support.ts';

/** A board as large as the owner's real one can grow to (the 3,600 cards of the stall report). */
const CARDS = 3_600;
/** The longest the daemon may go without answering anything else: one slice of one tick may not hold the loop longer. */
const LONGEST_SLICE_MS = 100;

const stateFile = (name: string) => manifest.data.state.find(candidate => candidate.name === name) as never;

const linked = (number: number): PrLink => ({
  url: prUrl(number),
  number,
  repo: REPO,
  state: 'unknown',
  draft: false,
  checks: 'none',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: null,
});

/** What real I/O does: the loop gets a turn before the call answers. */
const afterIo = async (): Promise<void> => await new Promise<void>(resolve => setImmediate(resolve));

describe('GitHubWatcher: one tick on a very large board', () => {
  it(`should never hold the event loop for ${String(LONGEST_SLICE_MS)} ms in one slice with ${String(CARDS)} watched cards whose PRs all changed`, async () => {
    // The real card store over an in-memory state folder: its schema checks and copies cost what they cost in the daemon.
    const store = new KernelCardStore(
      new MemoryStateFolder().port([stateFile('cards'), stateFile('counters')]),
      { cards: stateFile('cards'), counters: stateFile('counters') },
      new KeyedSerial(),
      { warn: () => undefined },
    );
    for (let at = 1; at <= CARDS; at += 1) {
      const seeded: Card = card({
        id: `F${String(at)}`,
        laneId: 'implement',
        workflow: 'quick',
        links: { prs: [linked(at)], branch: null, commits: [], docs: [] },
      });
      await store.write(seeded.id, async () => ({ task: seeded, result: null }));
    }
    const boardLanes = new FakeLanes(new Map([[PROJECT, lanes(PROJECT)]]));
    const service = new BoardService(world({ store: store as never, lanes: boardLanes }));
    const board: GitHubWatcherPorts['board'] = {
      snapshot: async () => await service.snapshot(),
      act: async (...parameters) => await service.act(...parameters),
      recordPullRequests: async (...parameters) => {
        await afterIo();
        return await service.recordPullRequests(...parameters);
      },
    };
    // One repository answers for every PR, each now open (so every card moves), as one `gh` call would.
    const everyPr = Object.fromEntries(Array.from({ length: CARDS }, (_, at) => [at + 1, prNode(at + 1)]));
    const reply = answer({ prs: everyPr });
    const copies = { repositoryOf: async () => null, branchOf: async () => null };
    const projects = { projects: async () => [] };
    const diagnostics = { warn: () => undefined };
    const now = () => NOW;
    const watcher = new GitHubWatcher({
      board,
      gh: {
        run: async () => {
          await afterIo();
          return { kind: 'ok', stdout: reply };
        },
      },
      copies,
      sessions: { cwdOf: async () => null },
      projects,
      transcripts: { tail: async () => ({ kind: 'unresolved' }) },
      nudges: { send: async () => undefined },
      clock: { now, random: () => 0.5 },
      diagnostics,
      unfiled: new UnfiledRefiler({
        board,
        sessions: { boardOf: async () => null },
        lanes: { laneSet: async project => await boardLanes.laneSet(project), propose: async () => null },
        projects,
        copies,
        clock: { now },
        diagnostics,
      }),
      version: '4.114.0',
    });

    // The longest the loop waited for a turn while the tick ran: the longest stretch of synchronous work in it.
    let running = true;
    let longest = 0;
    const watching = (async () => {
      while (running) {
        const at = performance.now();
        await afterIo();
        longest = Math.max(longest, performance.now() - at);
      }
    })();
    const report = await watcher.tick();
    running = false;
    await watching;

    should(report.written).have.length(CARDS);
    should(longest).be.below(LONGEST_SLICE_MS);
  }, 60_000);
});
