import { describe, it } from 'bun:test';
import { type CloseFinishedTerminalsResponse, type TerminalHoldersView } from '../../../../contract/index.ts';
import should from 'should';
import { SessionCommandError } from '../../../src/lib/session/errors.ts';
import { TerminalSlotsController } from '../../../../cli/lib/terminal-slots/controller.ts';
import type { ITerminalSlotsGateway } from '../../../../cli/lib/terminal-slots/ports.ts';
import { capturedPresenter } from '../session/controller-doubles.ts';

const HOLDERS: TerminalHoldersView = {
  limit: 24,
  open: 7,
  holders: [
    { sessionId: 's-1', label: 'fitzgerald', standing: 'finished', status: 'stopped', count: 6 },
    { sessionId: 's-2', label: 'wren', standing: 'live', status: 'running', count: 1 },
  ],
};

const CLOSED: CloseFinishedTerminalsResponse = {
  closed: 6,
  failed: 0,
  holders: [{ sessionId: 's-2', label: 'wren', standing: 'live', status: 'running', count: 1 }],
};

function harness(reply: unknown) {
  const paths: { path: string; method?: string }[] = [];
  const gateway = {
    request: async (path: string, _schema: unknown, init?: RequestInit) => {
      paths.push({ path, ...(init?.method === undefined ? {} : { method: init.method }) });
      return reply;
    },
  } as unknown as ITerminalSlotsGateway;
  const { io, presenter } = capturedPresenter();
  return { paths, io, sut: new TerminalSlotsController(gateway, presenter) };
}

describe('TerminalSlotsController', () => {
  it('should show who holds the slots and point at the cleanup when a finished ferret holds some', async () => {
    // Arrange
    const { sut, io, paths } = harness(HOLDERS);

    // Act
    await sut.slots({});

    // Assert
    should(paths).deepEqual([{ path: '/v1/terminals' }]);
    should(io.out).deepEqual([
      '7 terminals open of 24.',
      '  fitzgerald (stopped): 6 terminals',
      '  wren (running): 1 terminal',
      'Run `fy terminal close --all-finished` to close the finished ferrets’ terminals.',
    ]);
  });

  it('should not suggest a cleanup when only live ferrets hold terminals', async () => {
    // Arrange
    const { sut, io } = harness({ limit: 24, open: 1, holders: [HOLDERS.holders[1]] });

    // Act
    await sut.slots({});

    // Assert
    should(io.out).deepEqual(['1 terminal open of 24.', '  wren (running): 1 terminal']);
  });

  it('should say so when nothing is open', async () => {
    // Arrange
    const { sut, io } = harness({ limit: 24, open: 0, holders: [] });

    // Act
    await sut.slots({});

    // Assert
    should(io.out).deepEqual(['No terminals are open (limit 24).']);
  });

  it('should print the holders as JSON on request', async () => {
    // Arrange
    const { sut, io } = harness(HOLDERS);

    // Act
    await sut.slots({ json: true });

    // Assert
    should(JSON.parse(io.out.join('\n'))).deepEqual(HOLDERS);
  });

  it('should close the finished ferrets’ terminals and say who still holds the rest', async () => {
    // Arrange
    const { sut, io, paths } = harness(CLOSED);

    // Act
    await sut.closeFinished({});

    // Assert
    should(paths).deepEqual([{ path: '/v1/terminals/close-finished', method: 'POST' }]);
    should(io.out).deepEqual(['Closed 6 terminals.', 'Still open:', '  wren (running): 1 terminal']);
  });

  it('should say when no finished ferret held a terminal', async () => {
    // Arrange
    const { sut, io } = harness({ closed: 0, failed: 0, holders: [] });

    // Act
    await sut.closeFinished({});

    // Assert
    should(io.out).deepEqual(['No finished ferret holds a terminal.']);
  });

  it('should print the close result as JSON on request', async () => {
    // Arrange
    const { sut, io } = harness(CLOSED);

    // Act
    await sut.closeFinished({ json: true });

    // Assert
    should(JSON.parse(io.out.join('\n'))).deepEqual(CLOSED);
  });

  it('should exit non-zero when a terminal could not be closed', async () => {
    // Arrange
    const { sut, io } = harness({ closed: 1, failed: 1, holders: [] });

    // Act
    const failure = await sut.closeFinished({}).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(SessionCommandError);
    should(io.out).deepEqual(['Closed 1 terminal.', 'Could not close 1 terminal; try again.']);
  });
});
