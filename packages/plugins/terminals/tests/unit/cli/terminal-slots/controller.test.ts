import { describe, it } from 'bun:test';
import should from 'should';
import type { CloseFinishedTerminalsResponse, TerminalHoldersView } from '../../../../contract/index.ts';
import { TerminalSlotsController } from '../../../../cli/lib/terminal-slots/controller.ts';
import { capturedIo, recordingClient } from '../../../support/cli/doubles.ts';

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
  const { calls, client } = recordingClient(() => reply);
  const io = capturedIo();
  return { calls, io, sut: new TerminalSlotsController(client, io) };
}

const lines = (printed: readonly string[]): string[] => printed.join('').trimEnd().split('\n');

describe('TerminalSlotsController', () => {
  it('should show who holds the slots and point at the cleanup when a finished ferret holds some', async () => {
    // Arrange
    const { sut, io, calls } = harness(HOLDERS);

    // Act
    const code = await sut.slots({});

    // Assert
    should(code).equal(0);
    should(calls).deepEqual([{ route: 'GET /v1/terminals' }]);
    should(lines(io.printed)).deepEqual([
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
    should(lines(io.printed)).deepEqual(['1 terminal open of 24.', '  wren (running): 1 terminal']);
  });

  it('should say so when nothing is open', async () => {
    // Arrange
    const { sut, io } = harness({ limit: 24, open: 0, holders: [] });

    // Act
    await sut.slots({});

    // Assert
    should(lines(io.printed)).deepEqual(['No terminals are open (limit 24).']);
  });

  it('should print the holders as JSON on request', async () => {
    // Arrange
    const { sut, io } = harness(HOLDERS);

    // Act
    await sut.slots({ json: true });

    // Assert
    should(JSON.parse(io.printed.join(''))).deepEqual(HOLDERS);
  });

  it('should close the finished ferrets’ terminals and say who still holds the rest', async () => {
    // Arrange
    const { sut, io, calls } = harness(CLOSED);

    // Act
    const code = await sut.closeFinished({});

    // Assert
    should(code).equal(0);
    should(calls).deepEqual([{ route: 'POST /v1/terminals/close-finished' }]);
    should(lines(io.printed)).deepEqual(['Closed 6 terminals.', 'Still open:', '  wren (running): 1 terminal']);
  });

  it('should say when no finished ferret held a terminal', async () => {
    // Arrange
    const { sut, io } = harness({ closed: 0, failed: 0, holders: [] });

    // Act
    await sut.closeFinished({});

    // Assert
    should(lines(io.printed)).deepEqual(['No finished ferret holds a terminal.']);
  });

  it('should print the close result as JSON on request', async () => {
    // Arrange
    const { sut, io } = harness(CLOSED);

    // Act
    await sut.closeFinished({ json: true });

    // Assert
    should(JSON.parse(io.printed.join(''))).deepEqual(CLOSED);
  });

  it('should exit non-zero when a terminal could not be closed', async () => {
    // Arrange
    const { sut, io } = harness({ closed: 1, failed: 1, holders: [] });

    // Act
    const code = await sut.closeFinished({});

    // Assert
    should(code).equal(1);
    should(lines(io.printed)).deepEqual(['Closed 1 terminal.', 'Could not close 1 terminal; try again.']);
    should(io.errors).deepEqual(['1 terminal(s) could not be closed\n']);
  });

  it('should exit non-zero, saying why, when the daemon answers a shape it does not read', async () => {
    // Arrange
    const { sut, io } = harness({ limit: 'many' });

    // Act
    const code = await sut.slots({});

    // Assert
    should(code).equal(1);
    should(io.printed).deepEqual([]);
    should(io.errors.length).equal(1);
  });
});
