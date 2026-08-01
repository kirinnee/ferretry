import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import {
  registerReadsCommands,
  runCancellableStream,
  type ReadsCommandController,
  type StreamSignalSource,
} from '../../../src/lib/reads/commands.ts';

type Call = {
  readonly method: 'snapshot' | 'logs' | 'events' | 'stream' | 'wait';
  readonly id: string;
  readonly options: unknown;
};

class RecordingReadsController implements ReadsCommandController {
  readonly calls: Call[] = [];
  readonly streamSignals: AbortSignal[] = [];

  async snapshot(id: string, options: Parameters<ReadsCommandController['snapshot']>[1]): Promise<void> {
    this.calls.push({ method: 'snapshot', id, options });
  }

  async logs(id: string, options: Parameters<ReadsCommandController['logs']>[1]): Promise<void> {
    this.calls.push({ method: 'logs', id, options });
  }

  async events(id: string, options: Parameters<ReadsCommandController['events']>[1]): Promise<void> {
    this.calls.push({ method: 'events', id, options });
  }

  async stream(
    id: string,
    options: Parameters<ReadsCommandController['stream']>[1],
    signal: AbortSignal,
  ): Promise<void> {
    this.calls.push({ method: 'stream', id, options });
    this.streamSignals.push(signal);
  }

  async wait(id: string, options: Parameters<ReadsCommandController['wait']>[1]): Promise<void> {
    this.calls.push({ method: 'wait', id, options });
  }
}

function run(argv: string[]) {
  const controller = new RecordingReadsController();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerReadsCommands(program, controller);
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), controller };
}

class FakeSignals implements StreamSignalSource {
  readonly #listeners = new Map<'SIGINT' | 'SIGTERM', Set<() => void>>();

  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    const listeners = this.#listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  }

  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    this.#listeners.get(event)?.delete(listener);
  }

  emit(event: 'SIGINT' | 'SIGTERM'): void {
    const listeners = [...(this.#listeners.get(event) ?? [])];
    this.#listeners.delete(event);
    for (const listener of listeners) listener();
  }

  count(): number {
    return [...this.#listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

describe('operator read command surface', () => {
  it('should map the inherited one-shot read flags without rewriting them', async () => {
    // Arrange + Act
    const snapshot = run(['snapshot', 's1', '--json']);
    const logs = run(['logs', 's1', '--turn', '4']);
    const events = run(['events', 's1', '--after', '5', '--limit', '9', '--json']);
    const view = run(['view', 's1']);
    await Promise.all([snapshot.parsed, logs.parsed, events.parsed, view.parsed]);

    // Assert
    should(snapshot.controller.calls[0]).eql({ method: 'snapshot', id: 's1', options: { json: true } });
    should(logs.controller.calls[0]).eql({ method: 'logs', id: 's1', options: { turn: 4 } });
    should(events.controller.calls[0]).eql({
      method: 'events',
      id: 's1',
      options: { after: 5, limit: 9, json: true },
    });
    should(view.controller.calls[0]?.method).equal('events');
  });

  it('should pass the actual --interval option into stream', async () => {
    // Arrange
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const { parsed, controller } = run(['stream', 's1', '--after', '7', '--interval', '3', '--json']);

    // Act
    await parsed;

    // Assert
    should(controller.calls[0]).eql({
      method: 'stream',
      id: 's1',
      options: { after: 7, interval: 3, json: true },
    });
    should(process.listenerCount('SIGINT')).equal(beforeInt);
    should(process.listenerCount('SIGTERM')).equal(beforeTerm);
  });

  it('should pass the timeout, interval, and marker into wait', async () => {
    // Arrange + Act
    const { parsed, controller } = run([
      'wait',
      's1',
      '--timeout',
      '11',
      '--interval',
      '2',
      '--until-marker',
      'done.md',
      '--json',
    ]);
    await parsed;

    // Assert
    should(controller.calls[0]).eql({
      method: 'wait',
      id: 's1',
      options: { timeout: 11, interval: 2, untilMarker: 'done.md', json: true },
    });
  });

  it('should abort a stream and remove both signal listeners', async () => {
    // Arrange
    const signals = new FakeSignals();
    const controller = new RecordingReadsController();
    controller.stream = async (id, options, signal) => {
      controller.calls.push({ method: 'stream', id, options });
      controller.streamSignals.push(signal);
      await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
    };

    // Act
    const running = runCancellableStream(controller, 's1', {}, signals);
    signals.emit('SIGTERM');
    await running;

    // Assert
    should(controller.streamSignals[0]?.aborted).be.true();
    should(signals.count()).equal(0);
  });
});
