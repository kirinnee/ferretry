/**
 * Runtimes follows an ended Codex ferret (docs/design/account-model.md §8.4): it hears Ferrets' `ferrets.changed`,
 * reads the ferret through `FerretsPort`, and stops the app-server pair under its own runtime's `CODEX_HOME`. Ferrets
 * calls nothing of Runtimes. Booted through the kernel's test host with Ferrets' fake as the ONLY other plugin.
 */
import { describe, it } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { FerretsChanged, type FerretSummary } from '@ferretry/core-ferrets/contract';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { DaemonImplementation } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { fakeLoginChanges, fakeLoginEnvImport, fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import should from 'should';
import { RuntimesLaunchFailed } from '../../../contract/index.ts';
import { type RuntimesAssembly, runtimesDaemon, unavailableAssembly } from '../../../daemon/index.ts';
import { CODEX_OFFLINE_LAUNCH_ERROR, codexLaunchFailure } from '../../../contract/codex-launch.ts';
import type { CodexAppServerOutcome } from '../../../daemon/lib/service/codex-runtime.ts';
import { RuntimeEndSupervision, type RuntimeEndSeams } from '../../../daemon/lib/service/runtime-end-supervision.ts';

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

describe('the Runtimes daemon, booted with Ferrets and no other plugin', () => {
  async function boot(calls: Calls, ferrets: FakeFerrets) {
    const assembly = (): RuntimesAssembly => ({
      catalog: {} as RuntimesAssembly['catalog'],
      setup: {} as RuntimesAssembly['setup'],
      ended: seams(calls),
    });
    return await testHost({
      plugins: [runtimesDaemon(assembly) as DaemonImplementation<any>],
      fakes: {
        ferrets,
        logins: fakeLogins([]),
        loginChanges: fakeLoginChanges(),
        loginEnvImport: fakeLoginEnvImport(),
        vault: new FakeVault(),
      },
      gate: new StandInAdmission(() => ownerStanding()),
      config: { runtimes: {}, profiles: {} },
    });
  }

  it('should act on the ferrets.changed event of an ended Codex ferret, and publish the explained failure', async () => {
    // Arrange
    const calls: Calls = { ended: [], told: [] };
    const ferrets = new FakeFerrets();
    add(ferrets, {
      id: 'c1',
      harness: 'codex',
      runtime: 'codex-work',
      state: 'stopped',
      cause: { kind: 'start_failed', explained: EXPLAINED },
    });
    add(ferrets, {
      id: 'a1',
      harness: 'claude-code',
      runtime: 'claude-default',
      state: 'stopped',
      cause: { kind: 'stopped' },
    });
    const host = await boot(calls, ferrets);
    const before = host.published.length;

    // Act
    host.emit(FerretsChanged, { ferret: 'a1', generation: 1, state: 'stopped' });
    host.emit(FerretsChanged, { ferret: 'c1', generation: 1, state: 'stopped' });
    await host.settle();

    // Assert
    should(calls.ended).deepEqual(['/fy/fleet/bin/codex-work']);
    const published = host.published.slice(before);
    should(published.map(event => event.event)).deepEqual([RuntimesLaunchFailed.name]);
    should(published[0]?.payload).match({ ferret: 'c1', runtime: 'codex-work' });
  });

  it('should keep listening and change nothing while the host offers no follow-up seams', async () => {
    // Arrange
    const ferrets = new FakeFerrets();
    add(ferrets, { id: 'c1', harness: 'codex', runtime: 'codex-work', state: 'stopped' });
    const host = await testHost({
      plugins: [runtimesDaemon(unavailableAssembly) as DaemonImplementation<any>],
      fakes: {
        ferrets,
        logins: fakeLogins([]),
        loginChanges: fakeLoginChanges(),
        loginEnvImport: fakeLoginEnvImport(),
        vault: new FakeVault(),
      },
      gate: new StandInAdmission(() => ownerStanding()),
      config: { runtimes: {}, profiles: {} },
    });
    const before = host.published.length;

    // Act
    host.emit(FerretsChanged, { ferret: 'c1', generation: 1, state: 'stopped' });
    await host.settle();

    // Assert
    should(host.published.length).equal(before);
  });
});
