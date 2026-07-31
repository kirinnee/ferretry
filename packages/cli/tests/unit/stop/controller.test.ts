import { describe, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import should from 'should';
import { BulkStopController, inheritStopReason } from '../../../src/lib/stop/controller';
import type { BulkStopOptions, BulkStopSelector, IStopIo, IStopPrompt } from '../../../src/lib/stop/types';
import { session } from './fixtures';

const FLEET = [
  session({ id: 'lead' }),
  session({ id: 'mid', parent: 'lead' }),
  session({ id: 'worker-a', parent: 'mid', label: 'batch' }),
  session({ id: 'worker-b', parent: 'mid', label: 'batch' }),
];

interface Recorded {
  readonly out: string[];
  readonly errors: string[];
  readonly exitCodes: number[];
  readonly stopped: Array<{ id: string; reason: string }>;
  readonly asked: string[];
}

interface HarnessOptions {
  readonly fleet?: readonly SessionView[];
  readonly afterFleet?: readonly SessionView[];
  /** Sessions `get` can resolve that the listing does not report. */
  readonly resolvable?: readonly SessionView[];
  readonly interactive?: boolean;
  readonly callerId?: string;
  readonly answer?: string;
  readonly getFails?: string;
  readonly listFails?: string;
  readonly secondListFails?: string;
  readonly stopFails?: ReadonlySet<string>;
}

function harness(options: HarnessOptions = {}) {
  const recorded: Recorded = { out: [], errors: [], exitCodes: [], stopped: [], asked: [] };
  const fleet = options.fleet ?? FLEET;
  let listCalls = 0;

  const io: IStopIo = {
    success: message => recorded.out.push(message),
    warn: message => recorded.out.push(message),
    error: message => recorded.errors.push(message),
    setExitCode: code => recorded.exitCodes.push(code),
  };
  const prompt: IStopPrompt = {
    ask: async message => {
      recorded.asked.push(message);
      return options.answer ?? '';
    },
  };
  const gateway = {
    list: async (): Promise<SessionView[]> => {
      listCalls += 1;
      if (listCalls === 1 && options.listFails) throw new Error(options.listFails);
      if (listCalls > 1 && options.secondListFails) throw new Error(options.secondListFails);
      return [...(listCalls > 1 ? (options.afterFleet ?? fleet) : fleet)];
    },
    get: async (id: string): Promise<SessionView> => {
      if (options.getFails) throw new Error(options.getFails);
      const known = [...fleet, ...(options.resolvable ?? [])];
      const found = known.find(view => view.config.id === id || view.config.name === id);
      if (!found) throw new Error(`unknown session "${id}"`);
      return found;
    },
    stop: async (id: string, reason?: string): Promise<SessionView> => {
      if (options.stopFails?.has(id)) throw new Error(`daemon refused ${id}`);
      recorded.stopped.push({ id, reason: reason ?? '' });
      return session({ id, status: 'stopped' });
    },
  };

  const controller = new BulkStopController(gateway, io, prompt, {
    interactive: options.interactive ?? true,
    ...(options.callerId ? { callerId: options.callerId } : {}),
    binaryName: 'fy',
  });
  const run = (selector: BulkStopSelector, runOptions: BulkStopOptions = {}) => controller.run(selector, runOptions);
  return { recorded, run };
}

describe('reason inheritance', () => {
  it('should adopt a reason written before the subcommand', () => {
    // Act
    const actual = inheritStopReason({ yes: true }, 'parent reason');

    // Assert
    should(actual.reason).equal('parent reason');
  });

  it('should let a reason written on the subcommand win', () => {
    // Act
    const actual = inheritStopReason({ reason: 'own' }, 'parent reason');

    // Assert
    should(actual.reason).equal('own');
  });

  it('should leave the options untouched when no parent reason exists', () => {
    // Arrange
    const options = { yes: true };

    // Act
    const actual = inheritStopReason(options, undefined);

    // Assert
    should(actual).equal(options);
  });
});

describe('dry run', () => {
  it('should print the plan and stop nothing', async () => {
    // Arrange
    const { recorded, run } = harness();

    // Act
    const actual = await run({ kind: 'cascade', rootId: 'mid' }, { dryRun: true });

    // Assert
    should(actual.exitCode).equal(0);
    should(actual.confirmed).be.false();
    should(recorded.stopped).be.empty();
    should(recorded.out.join('\n')).containEql('Dry run: no sessions were stopped.');
  });
});

describe('empty selections', () => {
  it('should report nothing eligible without prompting', async () => {
    // Arrange
    const { recorded, run } = harness({ fleet: [session({ id: 'solo', status: 'completed' })] });

    // Act
    const actual = await run({ kind: 'label', label: 'nothing' }, {});

    // Assert
    should(actual.exitCode).equal(0);
    should(recorded.asked).be.empty();
    should(recorded.out.join('\n')).containEql('Nothing eligible to stop.');
  });
});

describe('selector resolution', () => {
  it('should resolve a lineage root through the daemon so aliases behave like a single stop', async () => {
    // Arrange — the fleet lists the session under its id; the operator typed its name.
    const { recorded, run } = harness({ answer: 'stop 3' });

    // Act
    const actual = await run({ kind: 'cascade', rootId: 'mid' }, {});

    // Assert
    should(actual.plan?.selector).deepEqual({ kind: 'cascade', rootId: 'mid' });
    should(recorded.stopped.map(entry => entry.id)).deepEqual(['mid', 'worker-a', 'worker-b']);
  });

  it('should add a resolved root the listing did not contain', async () => {
    // Arrange
    // `get` resolves it, `list` does not report it — the plan must still see it.
    const { run } = harness({ resolvable: [session({ id: 'hidden' })] });

    // Act
    const actual = await run({ kind: 'cascade', rootId: 'hidden' }, { yes: true });

    // Assert
    should(actual.plan?.targets.map(target => target.id)).deepEqual(['hidden']);
  });

  it('should fail cleanly when the daemon cannot resolve the root', async () => {
    // Arrange
    const { recorded, run } = harness({ getFails: 'session not found' });

    // Act
    const actual = await run({ kind: 'cascade', rootId: 'ghost' }, { yes: true });

    // Assert
    should(actual.exitCode).equal(1);
    should(actual.plan).be.undefined();
    should(recorded.errors).deepEqual(['session not found']);
    should(recorded.exitCodes).deepEqual([1]);
  });

  it('should reject a blank label before calling the daemon', async () => {
    // Arrange
    const { recorded, run } = harness();

    // Act
    const actual = await run({ kind: 'label', label: '  ' }, { yes: true });

    // Assert
    should(actual.exitCode).equal(1);
    should(recorded.errors).deepEqual(['label must not be empty']);
  });

  it('should reject a blank lineage id before calling the daemon', async () => {
    // Arrange
    const { recorded, run } = harness();

    // Act
    const actual = await run({ kind: 'orphan', rootId: '  ' }, { yes: true });

    // Assert
    should(actual.exitCode).equal(1);
    should(recorded.errors).deepEqual(['session id must not be empty']);
  });

  it('should report a listing failure rather than sweep a half-known fleet', async () => {
    // Arrange
    const { recorded, run } = harness({ listFails: 'daemon unreachable' });

    // Act
    const actual = await run({ kind: 'label', label: 'batch' }, { yes: true });

    // Assert
    should(actual.exitCode).equal(1);
    should(recorded.errors).deepEqual(['daemon unreachable']);
  });
});

describe('confirmation', () => {
  it('should refuse an unconfirmed sweep on non-interactive input', async () => {
    // Arrange
    const { recorded, run } = harness({ interactive: false });

    // Act
    const actual = await run({ kind: 'label', label: 'batch' }, {});

    // Assert
    should(actual.exitCode).equal(1);
    should(actual.confirmed).be.false();
    should(recorded.stopped).be.empty();
    should(recorded.errors[0]).containEql('re-run with --yes');
  });

  it('should stop nothing when the typed phrase does not match', async () => {
    // Arrange
    const { recorded, run } = harness({ answer: 'yes' });

    // Act
    const actual = await run({ kind: 'label', label: 'batch' }, {});

    // Assert
    should(actual.exitCode).equal(1);
    should(recorded.stopped).be.empty();
    should(recorded.errors).deepEqual(['Confirmation did not match; no sessions were stopped.']);
  });

  it('should accept the exact phrase with surrounding whitespace', async () => {
    // Arrange
    const { recorded, run } = harness({ answer: '  stop 2  ' });

    // Act
    const actual = await run({ kind: 'label', label: 'batch' }, {});

    // Assert
    should(actual.exitCode).equal(0);
    should(actual.confirmed).be.true();
    should(recorded.asked[0]).containEql('"stop 2"');
    should(recorded.stopped.map(entry => entry.id)).deepEqual(['worker-a', 'worker-b']);
  });

  it('should skip the prompt entirely under --yes', async () => {
    // Arrange
    const { recorded, run } = harness();

    // Act
    await run({ kind: 'label', label: 'batch' }, { yes: true });

    // Assert
    should(recorded.asked).be.empty();
  });
});

describe('the sweep', () => {
  it('should record the default reason naming the shipped binary', async () => {
    // Arrange
    const { recorded, run } = harness();

    // Act
    await run({ kind: 'label', label: 'batch' }, { yes: true });

    // Assert
    should(recorded.stopped[0]?.reason).equal('stopped by fy stop label batch');
  });

  it('should prefer an explicit reason and ignore a blank one', async () => {
    // Arrange
    const explicit = harness();
    const blank = harness();

    // Act
    await explicit.run({ kind: 'label', label: 'batch' }, { yes: true, reason: '  shift over  ' });
    await blank.run({ kind: 'label', label: 'batch' }, { yes: true, reason: '   ' });

    // Assert
    should(explicit.recorded.stopped[0]?.reason).equal('shift over');
    should(blank.recorded.stopped[0]?.reason).equal('stopped by fy stop label batch');
  });

  it('should continue past a refused stop and exit non-zero', async () => {
    // Arrange
    const { recorded, run } = harness({ stopFails: new Set(['worker-a']) });

    // Act
    const actual = await run({ kind: 'label', label: 'batch' }, { yes: true });

    // Assert
    should(actual.exitCode).equal(1);
    should(recorded.stopped.map(entry => entry.id)).deepEqual(['worker-b']);
    should(recorded.out.join('\n')).containEql('FAILED');
    should(recorded.exitCodes).deepEqual([1]);
  });

  it('should exclude the caller by default and include it last when asked', async () => {
    // Arrange
    const excluded = harness({ callerId: 'worker-a', answer: 'stop 1' });
    const included = harness({ callerId: 'worker-a', answer: 'stop 2 including caller' });

    // Act
    await excluded.run({ kind: 'label', label: 'batch' }, {});
    await included.run({ kind: 'label', label: 'batch' }, { includeCaller: true });

    // Assert
    should(excluded.recorded.stopped.map(entry => entry.id)).deepEqual(['worker-b']);
    should(included.recorded.stopped.map(entry => entry.id)).deepEqual(['worker-b', 'worker-a']);
  });

  it('should report sessions that appeared after confirmation and exit non-zero', async () => {
    // Arrange
    const late = session({ id: 'worker-c', parent: 'mid', label: 'batch' });
    const { recorded, run } = harness({ afterFleet: [...FLEET, late] });

    // Act
    const actual = await run({ kind: 'label', label: 'batch' }, { yes: true });

    // Assert
    should(actual.exitCode).equal(1);
    should(actual.sweep?.appeared.map(target => target.id)).deepEqual(['worker-c']);
    should(recorded.out.join('\n')).containEql('NOT stopped');
  });

  it('should report descendants that appeared after an orphan confirmation', async () => {
    // Arrange
    const late = session({ id: 'worker-c', parent: 'mid' });
    const { run } = harness({ afterFleet: [...FLEET, late] });

    // Act
    const actual = await run({ kind: 'orphan', rootId: 'mid' }, { yes: true });

    // Assert
    should(actual.sweep?.appearedLeftRunning.map(target => target.id)).deepEqual(['worker-c']);
  });

  it('should report a failed race check instead of claiming a clean sweep', async () => {
    // Arrange
    const { recorded, run } = harness({ secondListFails: 'daemon went away' });

    // Act
    const actual = await run({ kind: 'label', label: 'batch' }, { yes: true });

    // Assert
    should(actual.exitCode).equal(1);
    should(actual.sweep?.raceCheckError).equal('daemon went away');
    should(recorded.out.join('\n')).containEql('RACE CHECK FAILED');
  });

  it('should stringify a non-Error rejection rather than print "[object Object]"', async () => {
    // Arrange
    const gateway = {
      list: async () => [session({ id: 'solo', label: 'batch' })],
      get: async () => session({ id: 'solo' }),
      // biome-ignore lint/suspicious/useAwait: the port is async; this double rejects synchronously.
      stop: async (): Promise<never> => {
        throw 'plain string failure';
      },
    };
    const out: string[] = [];
    const io: IStopIo = { success: m => out.push(m), warn: () => {}, error: m => out.push(m), setExitCode: () => {} };
    const controller = new BulkStopController(
      gateway,
      io,
      { ask: async () => '' },
      {
        interactive: false,
        binaryName: 'fy',
      },
    );

    // Act
    const actual = await controller.run({ kind: 'label', label: 'batch' }, { yes: true });

    // Assert
    should(actual.sweep?.outcomes[0]?.error).equal('plain string failure');
    should(out.join('\n')).containEql('plain string failure');
  });

  it('should exit zero when every stop succeeded and nothing new appeared', async () => {
    // Arrange
    const { recorded, run } = harness();

    // Act
    const actual = await run({ kind: 'label', label: 'batch' }, { yes: true });

    // Assert
    should(actual.exitCode).equal(0);
    should(recorded.exitCodes).be.empty();
    should(recorded.out.join('\n')).containEql('Race check: no new matching sessions appeared');
  });
});
