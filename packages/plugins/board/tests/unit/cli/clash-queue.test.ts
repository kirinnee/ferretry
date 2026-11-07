import { describe, it } from 'bun:test';
import type { BoardMergeGateResponse, CardEvent, CardResponse } from '../../../contract/index.ts';
import should from 'should';
import { BoardController } from '../../../cli/lib/board-controller.ts';
import { queuedLines } from '../../../cli/lib/clash-notes.ts';
import {
  MERGE_GATE_UNREADABLE,
  MERGE_GATE_WAITING,
  checkMergeGate,
  mergeGateLines,
} from '../../../cli/lib/merge-gate.ts';
import type { BoardGateway } from '../../../cli/lib/ports.ts';
import { AT, card, DENISHA, directory, laneSet, listing, response, cardResponse } from './fixtures.ts';

const PR = 'https://github.com/kirinnee/ferretry/pull/42';
const QUEUED =
  'queued behind &F18 to merge: both claim knip.json. It can be built now; its PR merges after &F18 ships.';

const event = (seq: number, rest: Record<string, unknown>): CardEvent =>
  ({ seq, at: AT, actor: { kind: 'ferret', name: DENISHA, ferret: DENISHA }, ...rest }) as CardEvent;
const daemonNote = (seq: number, text: string): CardEvent =>
  ({ seq, at: AT, actor: { kind: 'daemon' }, type: 'note', text }) as CardEvent;

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

describe('mergeGateLines', () => {
  it('should say one line per waiting card, with how far each blocker must get', () => {
    // Act
    const lines = mergeGateLines({
      waits: [
        { card: { id: 'F20' }, on: { id: 'F18' }, until: 'shipped' },
        { card: { id: 'F20' }, on: { id: 'F19' }, until: 'released' },
        { card: { id: 'F21' }, on: { id: 'F18' }, until: 'shipped' },
      ],
    });

    // Assert
    should(lines).eql([
      '&F20 waits on &F18 (until shipped), &F19 (until released)',
      '&F21 waits on &F18 (until shipped)',
    ]);
  });
});

describe('checkMergeGate', () => {
  const answer = (overrides: Partial<BoardMergeGateResponse> = {}): BoardMergeGateResponse => ({
    pr: PR,
    unit: [],
    waits: [],
    unreadable: [],
    ...overrides,
  });
  const gate = (reply: BoardMergeGateResponse | Error) => {
    const io = new Io();
    const asked: string[] = [];
    const controller = async (url: string): Promise<number> =>
      await checkMergeGate(
        async pr => {
          asked.push(pr);
          if (reply instanceof Error) throw reply;
          return reply;
        },
        io,
        url,
      );
    return { controller, io, asked };
  };

  it('should exit 0 and say nothing when the PR waits on nothing', async () => {
    const { controller, io, asked } = gate(answer({ unit: [{ id: 'F20' }] }));
    io.exitCode = await controller(` ${PR} `);
    should(io.exitCode).equal(0);
    should(io.reports).eql([]);
    should(asked).eql([PR]);
  });

  it('should exit 1 with the waits', async () => {
    const { controller, io } = gate(answer({ waits: [{ card: { id: 'F20' }, on: { id: 'F18' }, until: 'shipped' }] }));
    io.exitCode = await controller(PR);
    should(io.exitCode).equal(MERGE_GATE_WAITING);
    should(io.reports).eql(['&F20 waits on &F18 (until shipped)']);
  });

  it('should exit 2 when a card cannot be read, since it might link the PR', async () => {
    const { controller, io } = gate(answer({ unreadable: ['F9'] }));
    io.exitCode = await controller(PR);
    should(io.exitCode).equal(MERGE_GATE_UNREADABLE);
    should(io.diagnostics[0]).containEql('&F9');
  });

  it('should exit 2 when the daemon cannot answer, so the merger fails closed', async () => {
    const { controller, io } = gate(new Error('daemon is not running'));
    io.exitCode = await controller(PR);
    should(io.exitCode).equal(MERGE_GATE_UNREADABLE);
    should(io.diagnostics[0]).containEql('daemon is not running');
  });

  it('should exit 2 for something that is not a PR URL, without asking', async () => {
    const { controller, io, asked } = gate(answer());
    io.exitCode = await controller('kirinnee/ferretry#42');
    should(io.exitCode).equal(MERGE_GATE_UNREADABLE);
    should(asked).eql([]);
  });
});

describe('fy card file prints the queue', () => {
  it('should say which card a clashing claim queued this one behind', async () => {
    // Arrange
    const queued = card({
      history: [
        event(1, { type: 'created', laneId: 'todo' }),
        event(2, { type: 'file-claimed', path: 'knip.json' }),
        daemonNote(3, QUEUED),
      ],
    });
    const gateway: BoardGateway = {
      board: async () => response(),
      card: async () => cardResponse(),
      create: async () => cardResponse(),
      act: async (): Promise<CardResponse> => cardResponse(queued, laneSet()),
      skip: async () => ({ ferret: DENISHA, skip: { reason: 'x', at: AT } }),
      projects: async () => listing(),
      ferrets: async () => directory,
      mergeGate: async () => ({ pr: PR, unit: [], waits: [], unreadable: [] }),
      related: async () => ({ matches: [] }),
    };
    const io = new Io();
    const controller = new BoardController({
      gateway,
      output: io,
      files: { readText: async () => '' },
      binary: 'fy',
      ownFerret: DENISHA,
    });

    // Act
    await controller.file('F1', 'knip.json', {});

    // Assert
    should(io.diagnostics).eql([`&F1 ${QUEUED}`]);
  });
});
