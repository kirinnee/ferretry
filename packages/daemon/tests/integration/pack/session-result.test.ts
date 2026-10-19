import { describe, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import should from 'should';
import { readSessionResult } from '../../../src/adapters/pack/session-result.ts';
import { DEFAULT_COMPLETION_SUMMARY } from '../../../src/lib/session/signal/policy.ts';

const view = (status: string, finishedAt?: string): SessionView =>
  ({
    config: { id: 'child-1' },
    state: { status, ...(finishedAt === undefined ? {} : { finishedAt }) },
  }) as unknown as SessionView;

function reader(text: string | undefined) {
  const calls = { count: 0 };
  return {
    calls,
    read: async () => {
      calls.count += 1;
      return text;
    },
  };
}

describe('readSessionResult', () => {
  it('should not read the summary of a ferret that is still running', async () => {
    // Arrange
    const source = reader('early words');

    // Act
    const result = await readSessionResult(view('running'), source.read);

    // Assert
    should(result).eql({ id: 'child-1', status: 'running', finished: false });
    should(source.calls.count).equal(0);
  });

  it('should return the summary of a finished ferret without its trailing newline, with the finish time', async () => {
    // Arrange
    const source = reader('Renamed 3 call sites.\n');

    // Act
    const result = await readSessionResult(view('completed', '2026-10-19T10:00:00.000Z'), source.read);

    // Assert
    should(result).eql({
      id: 'child-1',
      status: 'completed',
      finished: true,
      finishedAt: '2026-10-19T10:00:00.000Z',
      summary: 'Renamed 3 call sites.',
    });
  });

  it('should treat every ended status as finished', async () => {
    // Arrange + Act
    const results = await Promise.all(
      ['completed', 'failed', 'stalled', 'stopped'].map(status => readSessionResult(view(status), reader('x').read)),
    );

    // Assert
    should(results.map(result => result.finished)).eql([true, true, true, true]);
  });

  it('should read the default done sentence as no result', async () => {
    // Arrange
    const source = reader(DEFAULT_COMPLETION_SUMMARY);

    // Act
    const result = await readSessionResult(view('completed'), source.read);

    // Assert
    should(result).eql({ id: 'child-1', status: 'completed', finished: true });
  });

  it('should return no summary when none was written', async () => {
    // Arrange + Act
    const result = await readSessionResult(view('failed'), reader(undefined).read);

    // Assert
    should(result).eql({ id: 'child-1', status: 'failed', finished: true });
  });
});
