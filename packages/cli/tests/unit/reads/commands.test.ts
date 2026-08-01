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
  readonly method: 'attach' | 'snapshot' | 'logs' | 'events' | 'stream' | 'wait';
  /** `stream` is the one command whose id may legitimately be absent. */
  readonly id: string | undefined;
  readonly options: unknown;
};

class RecordingReadsController implements ReadsCommandController {
  readonly calls: Call[] = [];
  readonly streamSignals: AbortSignal[] = [];

  async attach(id: string): Promise<void> {
    this.calls.push({ method: 'attach', id, options: undefined });
  }

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
    id: string | undefined,
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

  it('should route attach to the controller with the session id alone', async () => {
    // Arrange + Act
    const { parsed, controller } = run(['attach', 's1']);
    await parsed;

    // Assert — attach takes no flags; every attach decision belongs to the daemon and the attacher.
    should(controller.calls[0]).eql({ method: 'attach', id: 's1', options: undefined });
  });

  it('should require a session id for attach', async () => {
    // Arrange + Act
    const { parsed, controller } = run(['attach']);
    const refusal = await parsed.catch((error: unknown) => error);

    // Assert — an attach with no target must fail loudly, never fall back to a fleet-wide guess.
    should(refusal).be.instanceof(Error);
    should(controller.calls).be.empty();
  });

  it('should pass the scoped stream flags through without rewriting them', async () => {
    // Arrange
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const { parsed, controller } = run(['stream', 's1', '--after', '7', '--json']);

    // Act
    await parsed;

    // Assert — the listeners are released with the command, so a finished stream leaves nothing behind.
    should(controller.calls[0]).eql({ method: 'stream', id: 's1', options: { after: 7, json: true } });
    should(process.listenerCount('SIGINT')).equal(beforeInt);
    should(process.listenerCount('SIGTERM')).equal(beforeTerm);
  });

  it('should follow the daemon-local fleet when stream is given no id', async () => {
    // Arrange + Act
    const { parsed, controller } = run(['stream', '--json']);
    await parsed;

    // Assert — the socket itself is daemon-scoped, so an absent id is a real form and not an error.
    should(controller.calls[0]).eql({ method: 'stream', id: undefined, options: { json: true } });
  });

  it('should no longer accept the poll interval the old follow loop needed', async () => {
    // Arrange + Act
    const { parsed, controller } = run(['stream', 's1', '--interval', '3']);
    const refusal = await parsed.catch((error: unknown) => error);

    // Assert — there is no poll to pace; accepting the flag would imply a cadence nothing honours.
    should(refusal).be.instanceof(Error).and.have.property('code', 'commander.unknownOption');
    should(controller.calls).be.empty();
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
