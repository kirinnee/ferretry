import { describe, it } from 'bun:test';
import type { BoardQueryInput, BoardResponse, BoardTaskEvent, BoardTaskResponse } from '@ferretry/protocol';
import should from 'should';
import { BoardController } from '../../../src/lib/board/board-controllers';
import { queuedLines } from '../../../src/lib/board/clash-notes';
import {
  MERGE_GATE_UNREADABLE,
  MERGE_GATE_WAITING,
  MergeGateController,
  mergeGateWaits,
} from '../../../src/lib/board/merge-gate';
import type { IBoardGateway } from '../../../src/lib/board/ports';
import { AT, card, DENISHA, directory, laneSet, listing, pr, response, taskResponse } from './fixtures';

const PR = 'https://github.com/kirinnee/ferretry/pull/42';
const QUEUED =
  'queued behind &F18 to merge: both claim knip.json. It can be built now; its PR merges after &F18 ships.';

const event = (seq: number, rest: Record<string, unknown>): BoardTaskEvent =>
  ({ seq, at: AT, actor: { kind: 'ferret', sessionId: DENISHA }, ...rest }) as BoardTaskEvent;
const daemonNote = (seq: number, text: string): BoardTaskEvent =>
  ({ seq, at: AT, actor: { kind: 'daemon', sessionId: DENISHA }, type: 'note', text }) as BoardTaskEvent;

class Io {
  readonly reports: string[] = [];
  readonly diagnostics: string[] = [];
  readonly successes: string[] = [];
  exitCode = 0;
  report(message: string) {
    this.reports.push(message);
  }
  diagnostic(message: string) {
    this.diagnostics.push(message);
  }
  success(message: string) {
    this.successes.push(message);
  }
  setExitCode(code: number) {
    this.exitCode = code;
  }
}

describe('queuedLines', () => {
  it("should read the daemon's notes written after the last claim", () => {
    // Arrange
    const history = [
      event(1, { type: 'created', laneId: 'todo' }),
      daemonNote(2, 'an older note from another claim'),
      event(3, { type: 'file-claimed', path: 'knip.json' }),
      event(4, { type: 'depended', task: { id: 'F18' }, until: 'shipped', actor: { kind: 'daemon' } }),
      daemonNote(5, QUEUED),
      event(6, { type: 'note', text: 'a ferret note' }),
    ];

    // Act
    const lines = queuedLines({ history });

    // Assert
    should(lines).eql([QUEUED]);
  });

  it('should read nothing when the claim clashed with nothing', () => {
    const history = [event(1, { type: 'created', laneId: 'todo' }), event(2, { type: 'file-claimed', path: 'a.ts' })];
    should(queuedLines({ history })).eql([]);
  });
});

describe('mergeGateWaits', () => {
  it('should name every open card linking the PR that still waits, with how far', () => {
    // Arrange
    const cards = [
      card({
        id: 'F20',
        links: {
          prs: [pr({ url: 'https://github.com/KirinNee/Ferretry/pull/42', repo: 'KirinNee/Ferretry' })],
          branch: null,
          commits: [],
          docs: [],
        },
        dependsOn: [{ task: { id: 'F18' }, until: 'shipped' }],
        blockedBy: [{ id: 'F18' }],
      }),
      card({ id: 'F21', links: { prs: [pr({ url: PR })], branch: null, commits: [], docs: [] } }),
      card({ id: 'F22', blockedBy: [{ id: 'F18' }], dependsOn: [{ task: { id: 'F18' }, until: 'shipped' }] }),
    ];

    // Act
    const waits = mergeGateWaits({ repo: 'kirinnee/ferretry', number: 42 }, cards);

    // Assert
    should(waits.map(wait => [wait.card.id, wait.blockers])).eql([['F20', ['&F18 (until shipped)']]]);
  });
});

describe('MergeGateController', () => {
  const gate = (pages: readonly BoardResponse[] | Error) => {
    const io = new Io();
    const queries: BoardQueryInput[] = [];
    const controller = new MergeGateController({
      gateway: {
        board: async query => {
          queries.push(query);
          if (pages instanceof Error) throw pages;
          return pages[queries.length - 1] ?? response();
        },
      },
      io,
    });
    return { controller, io, queries };
  };

  it('should exit 0 and say nothing when the PR waits on nothing', async () => {
    const { controller, io } = gate([
      response({ cards: [card({ links: { prs: [pr()], branch: null, commits: [], docs: [] } })] }),
    ]);
    await controller.check(PR);
    should(io.exitCode).equal(0);
    should(io.reports).eql([]);
  });

  it('should exit 1 with the waits, reading every open card on every board page by page', async () => {
    // Arrange
    const waiting = card({
      id: 'F20',
      links: { prs: [pr()], branch: null, commits: [], docs: [] },
      dependsOn: [{ task: { id: 'F18' }, until: 'released' }],
      blockedBy: [{ id: 'F18' }],
    });
    const { controller, io, queries } = gate([
      response({ projectId: null, laneSet: null, cards: [card({ id: 'F1' })], nextCursor: 'next' }),
      response({ projectId: null, laneSet: null, cards: [waiting] }),
    ]);

    // Act
    await controller.check(PR);

    // Assert
    should(io.exitCode).equal(MERGE_GATE_WAITING);
    should(io.reports).eql(['&F20 waits on &F18 (until released)']);
    should(queries).eql([
      { state: 'open', visibility: 'all', limit: 500 },
      { state: 'open', visibility: 'all', limit: 500, cursor: 'next' },
    ]);
  });

  it('should exit 2 when the board cannot be read, so the merger fails closed', async () => {
    const { controller, io } = gate(new Error('daemon is not running'));
    await controller.check(PR);
    should(io.exitCode).equal(MERGE_GATE_UNREADABLE);
    should(io.diagnostics[0]).containEql('daemon is not running');
  });

  it('should exit 2 for something that is not a PR URL', async () => {
    const { controller, io, queries } = gate([]);
    await controller.check('kirinnee/ferretry#42');
    should(io.exitCode).equal(MERGE_GATE_UNREADABLE);
    should(queries).eql([]);
  });

  it('should exit 2 rather than loop on a board that never ends', async () => {
    const endless = Array.from({ length: 41 }, () => response({ projectId: null, laneSet: null, nextCursor: 'more' }));
    const { controller, io } = gate(endless);
    await controller.check(PR);
    should(io.exitCode).equal(MERGE_GATE_UNREADABLE);
  });
});

describe('fy task file prints the queue', () => {
  it('should say which card a clashing claim queued this one behind', async () => {
    // Arrange
    const queued = card({
      history: [
        event(1, { type: 'created', laneId: 'todo' }),
        event(2, { type: 'file-claimed', path: 'knip.json' }),
        daemonNote(3, QUEUED),
      ],
    });
    const gateway: IBoardGateway = {
      board: async () => response(),
      task: async () => taskResponse(),
      create: async () => taskResponse(),
      act: async (): Promise<BoardTaskResponse> => taskResponse(queued, laneSet()),
      skip: async () => ({ sessionId: DENISHA, skip: { reason: 'x', at: AT } }),
      projects: async () => listing(),
      sessions: async () => directory,
    };
    const io = new Io();
    const controller = new BoardController({
      gateway,
      output: io,
      files: { readText: async () => '' },
      binary: 'fy',
      environmentSessionId: DENISHA,
    });

    // Act
    await controller.file('F1', 'knip.json', {});

    // Assert
    should(io.diagnostics).eql([`&F1 ${QUEUED}`]);
  });
});
