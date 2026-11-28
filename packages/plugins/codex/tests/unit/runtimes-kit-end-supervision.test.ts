/**
/**
 * The Codex plugin follows an ended Codex ferret (docs/design/account-model.md §8.4): Runtimes hands it Ferrets' `ferrets.changed`
 * (the kit's `onFerretChanged`), it reads the ferret through `FerretsPort`, and stops the app-server pair under its own
 * runtime's `CODEX_HOME`. Ferrets calls nothing of Runtimes.
 */
import { describe, it } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import { CODEX_OFFLINE_LAUNCH_ERROR, codexLaunchFailure, type KitEndHost } from '@ferretry/plugin-runtimes/contract';
import should from 'should';
import type { CodexAppServerOutcome } from '../../daemon/lib/runtimes-kit/codex-runtime.ts';
import { codexRuntimesKit } from '../../daemon/lib/runtimes-kit/index.ts';
import { RuntimeEndSupervision, type RuntimeEndSeams } from '../../daemon/lib/runtimes-kit/runtime-end-supervision.ts';

// The sentence the Codex harness hands Ferrets for a pane showing this, which Ferrets records on the stopped ferret.
const EXPLAINED = codexLaunchFailure(
  'Error: JSON-RPC error: workspace routing discovery failed (connect ENETUNREACH)',
) as string;
const stopped: CodexAppServerOutcome = { kind: 'stopped', home: '/fy/fleet/homes/codex-work', pids: [11, 12] };

interface Calls {
  readonly ended: string[];
  readonly told: { ferret: string; runtime: string; message: string }[];
}

function seams(calls: Calls): RuntimeEndSeams {
  return {
    supervisor: {
      afterSessionEnded: async wrapper => {
        calls.ended.push(wrapper);
        return stopped;
      },
    },
    wrapperOf: async runtime => (runtime === 'codex-work' ? '/fy/fleet/bin/codex-work' : undefined),
  };
}

function reactor(ferrets: FakeFerrets, options: { readonly none?: boolean } = {}) {
  const calls: Calls = { ended: [], told: [] };
  const supervision = new RuntimeEndSupervision({
    ferrets,
    seams: options.none === true ? undefined : seams(calls),
    launchFailed: failure => calls.told.push({ ...failure }),
  });
  return { calls, supervision };
}

const add = (ferrets: FakeFerrets, summary: Omit<Partial<FerretSummary>, 'id'> & { readonly id: string }) =>
  ferrets.add({ ...summary, id: ferretId(summary.id) });

describe('Runtimes follows an ended ferret', () => {
  it('should stop the app-server pair of the runtime an ended Codex ferret ran', async () => {
    // Arrange
    const ferrets = new FakeFerrets();
    add(ferrets, { id: 'c1', harness: 'codex', runtime: 'codex-work', state: 'stopped', cause: { kind: 'stopped' } });
    const { calls, supervision } = reactor(ferrets);

    // Act
    await supervision.onChanged({ ferret: 'c1', state: 'stopped' });

    // Assert
    should(calls.ended).deepEqual(['/fy/fleet/bin/codex-work']);
    should(calls.told).deepEqual([]);
  });

  it('should do nothing for a Claude ferret', async () => {
    // Arrange
    const ferrets = new FakeFerrets();
    add(ferrets, {
      id: 'a1',
      harness: 'claude-code',
      runtime: 'codex-work',
      state: 'stopped',
      cause: { kind: 'stopped' },
    });
    const { calls, supervision } = reactor(ferrets);

    // Act
    await supervision.onChanged({ ferret: 'a1', state: 'stopped' });

    // Assert
    should(calls.ended).deepEqual([]);
    should(calls.told).deepEqual([]);
  });

  it('should do nothing while a Codex ferret has not stopped, or when the event says nothing of its state', async () => {
    // Arrange
    const ferrets = new FakeFerrets();
    add(ferrets, { id: 'c1', harness: 'codex', runtime: 'codex-work', state: 'working' });
    const { calls, supervision } = reactor(ferrets);

    // Act
    await supervision.onChanged({ ferret: 'c1', state: 'working' });
    await supervision.onChanged({ ferret: 'c1' });
    await supervision.onChanged({ ferret: 'c1', gone: true });
    // A stale event: the event said stopped, the port says it is running again (resumed).
    await supervision.onChanged({ ferret: 'c1', state: 'stopped' });

    // Assert
    should(calls.ended).deepEqual([]);
  });

  it('should do nothing for a ferret that ran no runtime, a runtime nothing is published under, or one Ferrets lost', async () => {
    // Arrange
    const ferrets = new FakeFerrets();
    add(ferrets, { id: 'c1', harness: 'codex', state: 'stopped' });
    add(ferrets, { id: 'c2', harness: 'codex', runtime: 'unpublished', state: 'stopped' });
    const { calls, supervision } = reactor(ferrets);

    // Act
    for (const ferret of ['c1', 'c2', 'missing']) await supervision.onChanged({ ferret, state: 'stopped' });

    // Assert
    should(calls.ended).deepEqual([]);
  });

  it('should tell the owner why a Codex ferret that could not reach the network never started', async () => {
    // Arrange
    const ferrets = new FakeFerrets();
    add(ferrets, {
      id: 'c1',
      harness: 'codex',
      runtime: 'codex-work',
      state: 'stopped',
      cause: { kind: 'start_failed', explained: EXPLAINED },
    });
    const { calls, supervision } = reactor(ferrets);

    // Act
    await supervision.onChanged({ ferret: 'c1', state: 'stopped' });

    // Assert — the pair is still stopped, and the sentence is Ferretry's, not the pane's.
    should(calls.ended).deepEqual(['/fy/fleet/bin/codex-work']);
    should(calls.told).have.length(1);
    should(calls.told[0]?.message.startsWith(CODEX_OFFLINE_LAUNCH_ERROR)).be.true();
    should(calls.told[0]?.message).not.containEql('ENETUNREACH');
  });

  it('should say nothing about a failed launch the harness had no sentence for', async () => {
    // Arrange: Ferrets recorded the failure, but the harness did not recognise the screen (no `explained`).
    const ferrets = new FakeFerrets();
    add(ferrets, {
      id: 'c1',
      harness: 'codex',
      runtime: 'codex-work',
      state: 'stopped',
      cause: { kind: 'start_failed' },
    });
    const { calls, supervision } = reactor(ferrets);

    // Act
    await supervision.onChanged({ ferret: 'c1', state: 'stopped' });

    // Assert — the pair is still stopped, and nobody is told.
    should(calls.ended).deepEqual(['/fy/fleet/bin/codex-work']);
    should(calls.told).deepEqual([]);
  });

  it('should not fail the ending when the supervisor throws or the host offers no seams', async () => {
    // Arrange
    const ferrets = new FakeFerrets();
    add(ferrets, { id: 'c1', harness: 'codex', runtime: 'codex-work', state: 'stopped' });
    const none = reactor(ferrets, { none: true });
    const throwing = new RuntimeEndSupervision({
      ferrets,
      seams: {
        ...seams({ ended: [], told: [] }),
        supervisor: { afterSessionEnded: async () => Promise.reject(new Error('boom')) },
      },
      launchFailed: () => undefined,
    });

    // Act / Assert
    await none.supervision.onChanged({ ferret: 'c1', state: 'stopped' });
    await throwing.onChanged({ ferret: 'c1', state: 'stopped' });
    should(none.calls.ended).deepEqual([]);
  });
});

describe('the Codex kit follows an ended ferret', () => {
  const host = (
    calls: string[],
    inventory: readonly { kind: string; wrapper: string; home: string }[] = [],
  ): KitEndHost => ({
    inventory: { accounts: async () => inventory },
    fleet: {} as KitEndHost['fleet'],
    processes: {} as KitEndHost['processes'],
    homesDirectory: () => '/fy/fleet/homes',
    sleep: async () => undefined,
    wrapperOf: async runtime => {
      calls.push(`wrapperOf ${runtime}`);
      return runtime === 'codex-work' ? '/fy/fleet/bin/codex-work' : undefined;
    },
  });
  const input = (ferrets: FakeFerrets, calls: string[], offered: KitEndHost | undefined) => ({
    ferrets,
    host: offered,
    launchFailed: (failure: { ferret: string }) => calls.push(`told ${failure.ferret}`),
  });

  it('should look at a stopped Codex ferret through the host and tell why a launch that failed never started', async () => {
    const calls: string[] = [];
    const ferrets = new FakeFerrets();
    add(ferrets, {
      id: 'c1',
      harness: 'codex',
      runtime: 'codex-work',
      state: 'stopped',
      cause: { kind: 'start_failed', explained: EXPLAINED },
    });

    await codexRuntimesKit.onFerretChanged?.(input(ferrets, calls, host(calls)), { ferret: 'c1', state: 'stopped' });

    // The runtime is published nowhere in the inventory, so no app server is stopped, but the failure is still told.
    should(calls).deepEqual(['wrapperOf codex-work', 'told c1']);
  });

  it('should do nothing for a Claude ferret, or while the host offers nothing', async () => {
    const calls: string[] = [];
    const ferrets = new FakeFerrets();
    add(ferrets, {
      id: 'a1',
      harness: 'claude-code',
      runtime: 'claude-work',
      state: 'stopped',
      cause: { kind: 'stopped' },
    });
    add(ferrets, { id: 'c1', harness: 'codex', runtime: 'codex-work', state: 'stopped' });

    await codexRuntimesKit.onFerretChanged?.(input(ferrets, calls, host(calls)), { ferret: 'a1', state: 'stopped' });
    await codexRuntimesKit.onFerretChanged?.(input(ferrets, calls, undefined), { ferret: 'c1', state: 'stopped' });

    should(calls).deepEqual([]);
  });
});

describe('the Codex kit when the host cannot be used', () => {
  it('should say why the follow-up did not run, and never fail the ending', async () => {
    const told: string[] = [];
    const ferrets = new FakeFerrets();
    add(ferrets, { id: 'c1', harness: 'codex', runtime: 'codex-work', state: 'stopped' });
    const broken = {
      get inventory(): never {
        throw new Error('the fleet root is not there');
      },
    } as unknown as KitEndHost;

    await codexRuntimesKit.onFerretChanged?.(
      { ferrets, host: broken, warn: line => told.push(line), launchFailed: () => undefined },
      { ferret: 'c1', state: 'stopped' },
    );

    should(told).deepEqual([
      "a Codex ferret stopped, but its runtime's follow-up could not run: the fleet root is not there",
    ]);
  });
});
