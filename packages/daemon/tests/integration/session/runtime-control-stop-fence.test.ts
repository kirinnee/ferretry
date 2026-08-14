import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RuntimeControlRequest, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  FileSessionEffectLedger,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageSessionLifecycleRepository,
  SystemClock,
} from '../../../src/adapters/index.ts';
import type { CodexPickerCleanup } from '../../../src/lib/session/harness/cleanup.ts';
import { HarnessQuirkService } from '../../../src/lib/session/harness/service.ts';
import {
  CodexRuntimeCatalogCache,
  createSessionPaths,
  createSessionRecord,
  defaultSessionLifecycleSettings,
  parseSessionId,
  type SerialExecutor,
  type SessionLifecycleLauncher,
  SessionLifecycleService,
  transitionSessionRecord,
} from '../../../src/lib/index.ts';
import { runtimeRequestFingerprint } from '../../../src/lib/session/runtime-control/ledger.ts';
import {
  runtimeQuarantineState,
  SessionRuntimeControlService,
  type SessionRuntimeControlPorts,
} from '../../../src/lib/session/runtime-control/service.ts';
import { SessionRuntimeError } from '../../../src/lib/session/runtime-control/types.ts';
import { sessionView } from '../../unit/runtime/mounts/support.ts';

/**
 * The production composition invariant in one deterministic fixture.
 *
 * Lifecycle stop and mounted runtime control share one observed production `KeyedSerialExecutor`.
 * The session record and effect admission are real files. Only tmux and the harness transport are
 * test boundaries, and every possible pane input is recorded in one ordered log.
 */

const NOW = '2026-08-07T16:45:00.000Z';
const STARTED_AT = '2026-08-07T16:40:00.000Z';
const TERMINATED_AT = '2026-08-07T16:42:00.000Z';
const SESSION = parseSessionId('runtime-stop-fence');
const STOP_REASON = 'operator stop';
const STOP_FAILURE = 'tmux refused';
const AGENT = '/opt/fleet/bin/claude-auto-loge';
const COMPACT = { action: 'compact' } as const satisfies RuntimeControlRequest;

const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}

function gate(): Gate {
  const held = Promise.withResolvers<void>();
  return { promise: held.promise, release: () => held.resolve() };
}

/** One real executor with request and entry boundaries the test can await without a sleep. */
class ObservedSerial implements SerialExecutor {
  readonly requested: string[] = [];
  readonly entered: string[] = [];
  readonly #delegate = new KeyedSerialExecutor();
  readonly #waiters: Array<{ readonly count: number; readonly release: () => void }> = [];

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.requested.push(key);
    this.#releaseWaiters();
    return await this.#delegate.run(key, async () => {
      this.entered.push(key);
      return await work();
    });
  }

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return await this.#delegate.runExclusive(work);
  }

  async waitForRequests(count: number): Promise<void> {
    if (this.requested.length >= count) return;
    const waiting = Promise.withResolvers<void>();
    this.#waiters.push({ count, release: waiting.resolve });
    await waiting.promise;
  }

  #releaseWaiters(): void {
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      if (waiter !== undefined && this.requested.length >= waiter.count) {
        this.#waiters.splice(index, 1);
        waiter.release();
      }
    }
  }
}

interface FixtureOptions {
  readonly stopEntered?: Gate;
  readonly stopRelease?: Gate;
  readonly inputEntered?: Gate;
  readonly inputRelease?: Gate;
  readonly harness?: 'claude' | 'codex';
  readonly pickerFailure?: boolean;
  readonly beforePickerFailure?: () => Promise<void>;
}

async function openStorage(home: string) {
  return await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  ).open();
}

async function buildFixture(options: FixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-runtime-stop-fence-'));
  homes.add(home);
  const opened = await openStorage(home);
  const storage = opened.storage;
  const serial = new ObservedSerial();
  const actions: string[] = [];
  const harness = options.harness ?? 'claude';
  const executable = harness === 'codex' ? '/opt/fleet/bin/codex-auto-loge' : AGENT;
  const wire = sessionView(
    SESSION,
    { harness, agent: harness === 'codex' ? 'codex-auto-loge' : 'claude-auto-loge' },
    { status: 'running', startedAt: STARTED_AT, finishedAt: TERMINATED_AT, exitCode: 137 },
  );
  const initialRepository = new StorageSessionLifecycleRepository(
    storage,
    wire.config as unknown as ConstructorParameters<typeof StorageSessionLifecycleRepository>[1],
  );
  const created = createSessionRecord(
    { agent: executable, command: [executable], cwd: '/work/ferretry', mode: 'interactive', name: 'Runtime fence' },
    { id: SESSION, cwd: '/work/ferretry', at: STARTED_AT, settings: defaultSessionLifecycleSettings },
  ).record;
  const starting = transitionSessionRecord(created, 'starting', STARTED_AT).record;
  const running = transitionSessionRecord(starting, 'running', STARTED_AT);
  await initialRepository.reserve(SESSION);
  await initialRepository.write(running.record, running.event);
  await storage.updateState(SESSION, current => ({
    ...(current as Record<string, unknown>),
    turn: 1,
    promptReady: true,
    finishedAt: TERMINATED_AT,
    exitCode: 137,
  }));

  const effects = new FileSessionEffectLedger(id => createSessionPaths(opened.paths, id).directory);
  const lifecycleRepository = new StorageSessionLifecycleRepository(storage);
  const launcher: SessionLifecycleLauncher = {
    alive: async () => true,
    launch: async () => {
      throw new Error('the race fixture never launches a pane');
    },
    ready: async () => undefined,
    deliver: async () => {
      throw new Error('the race fixture never delivers a first turn');
    },
    snapshot: async () => {
      actions.push('lifecycle:snapshot');
    },
    stop: async () => {
      actions.push('lifecycle:stop');
      options.stopEntered?.release();
      if (options.stopRelease !== undefined) await options.stopRelease.promise;
      throw new Error(STOP_FAILURE);
    },
  };
  const lifecycle = new SessionLifecycleService(
    {
      repository: lifecycleRepository,
      launcher,
      tasks: { writeAssignedTask: async () => '/unused/turn.md' },
      effects,
      directories: { resolve: async path => path },
      ids: { next: () => SESSION },
      clock: { now: () => NOW },
      serial,
    },
    defaultSessionLifecycleSettings,
  );

  const view = async () => {
    const [config, state] = await Promise.all([storage.readConfig(SESSION), storage.readState(SESSION)]);
    if (config === undefined || state === undefined) return undefined;
    return SessionViewSchema.parse({ config, state, directory: createSessionPaths(opened.paths, SESSION).directory });
  };
  const cleanup = {
    async dismiss() {
      return { kind: 'unconfirmed', reason: 'the picker could not be closed' } as const;
    },
  } as unknown as CodexPickerCleanup;
  const runtimePorts: SessionRuntimeControlPorts = {
    repository: {
      find: reference => (reference === SESSION ? { kind: 'session', id: SESSION } : { kind: 'missing' as const }),
      view: async id => (id === SESSION ? await view() : undefined),
      launch: async id =>
        id === SESSION ? { tmuxSession: 'fy-runtime-stop-fence', agent: executable, cwd: '/work/ferretry' } : undefined,
      journal: async (id, event, data) => {
        actions.push(`journal:${event}`);
        await storage.append(id, event, data);
      },
      quarantine: async (id, patch) => {
        actions.push('quarantine');
        await storage.updateState(id, current => runtimeQuarantineState(current, patch));
      },
    },
    effects,
    pane: {
      state: async () => {
        actions.push('pane:state');
        return { alive: true, dead: false, promptReady: true };
      },
      stop: async () => {
        actions.push('pane:stop');
      },
    },
    injector: {
      deliver: async (_session, command) => {
        actions.push(`inject:${command}`);
        options.inputEntered?.release();
        if (options.inputRelease !== undefined) await options.inputRelease.promise;
        return 'handled-local';
      },
    },
    picker: () => ({
      openPicker: async () => {
        actions.push('picker:open');
        await options.beforePickerFailure?.();
        if (options.pickerFailure === true) throw new Error('picker transport failed');
        return 'handled-local';
      },
      readPane: async () => {
        actions.push('picker:read');
        return { alive: true, dead: false, promptReady: false, visible: '' };
      },
      sendKey: async key => {
        actions.push(`picker:key:${key}`);
      },
    }),
    harness: new HarnessQuirkService(cleanup, 'fy'),
    accounts: { accounts: async () => [] },
    catalog: new CodexRuntimeCatalogCache(async () => [
      {
        value: 'gpt-5.6-codex',
        label: 'Codex',
        reasoningEfforts: [{ value: 'high' }, { value: 'max' }],
      },
    ]),
    serial,
    sleeper: { sleep: async () => undefined },
    clock: { now: () => NOW },
    clientName: 'fy',
  };
  const runtime = new SessionRuntimeControlService(runtimePorts);

  return {
    actions,
    effects,
    lifecycle,
    runtime,
    serial,
    storage,
    view,
    close: async () => {
      await storage.close();
      await rm(home, { recursive: true, force: true });
      homes.delete(home);
    },
  };
}

async function rejected<T>(promise: Promise<T>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function inputActions(actions: readonly string[]): readonly string[] {
  return actions.filter(
    action => action.startsWith('inject:') || action === 'picker:open' || action.startsWith('picker:key:'),
  );
}

describe('runtime control and lifecycle stop share one mutation fence', () => {
  it('should let a failed stop win before queued runtime control with zero pane input', async () => {
    // Arrange: stop owns the fence and waits inside its failing tmux boundary. Runtime is submitted
    // while held, so the observed serial proves it queued rather than merely arriving later.
    const stopEntered = gate();
    const stopRelease = gate();
    const fixture = await buildFixture({ stopEntered, stopRelease });
    try {
      const stopping = rejected(fixture.lifecycle.stop(SESSION, STOP_REASON));
      await stopEntered.promise;

      // Act
      const controlling = rejected(fixture.runtime.control(SESSION, COMPACT, 'stop-wins'));
      await fixture.serial.waitForRequests(2);
      should(fixture.serial.entered).deepEqual([SESSION]);
      stopRelease.release();
      const [stopError, runtimeError] = await Promise.all([stopping, controlling]);

      // Assert: the queued runtime re-read the durable state after entering and refused before every
      // injector and picker transport boundary. The stop's terminal evidence is untouched.
      should(stopError).be.instanceOf(Error).and.have.property('message', STOP_FAILURE);
      should(runtimeError).be.instanceOf(SessionRuntimeError).and.have.property('failure', 'refused');
      should(inputActions(fixture.actions)).deepEqual([]);
      should(fixture.actions).not.containEql('pane:state');
      should(fixture.serial.entered).deepEqual([SESSION, SESSION]);
      should(await fixture.storage.readState(SESSION)).containDeep({
        status: 'kill_failed',
        reason: `${STOP_REASON}: ${STOP_FAILURE}`,
        finishedAt: TERMINATED_AT,
        exitCode: 137,
      });
    } finally {
      await fixture.close();
    }
  });

  it('should finish one runtime input before a queued failed stop, with no post-stop input', async () => {
    // Arrange: compact owns the shared fence at its first irreversible input. The stop request is
    // observed while that entry remains the only entry, so it cannot snapshot or kill early.
    const inputEntered = gate();
    const inputRelease = gate();
    const fixture = await buildFixture({ inputEntered, inputRelease });
    try {
      const controlling = fixture.runtime.control(SESSION, COMPACT, 'runtime-wins');
      await inputEntered.promise;
      const stopping = rejected(fixture.lifecycle.stop(SESSION, STOP_REASON));
      await fixture.serial.waitForRequests(2);
      should(fixture.serial.entered).deepEqual([SESSION]);
      should(fixture.actions).not.containEql('lifecycle:snapshot');

      // Act
      inputRelease.release();
      await controlling;
      const stopError = await stopping;

      // Assert: exactly one runtime input preceded stop; nothing can enter afterwards, and the
      // failed stop replaces the weaker running verdict with its exact durable reason.
      should(stopError).be.instanceOf(Error).and.have.property('message', STOP_FAILURE);
      should(inputActions(fixture.actions)).deepEqual(['inject:/compact']);
      should(fixture.actions.indexOf('inject:/compact')).be.below(fixture.actions.indexOf('lifecycle:snapshot'));
      should(fixture.actions.indexOf('lifecycle:snapshot')).be.below(fixture.actions.indexOf('lifecycle:stop'));
      should(fixture.serial.entered).deepEqual([SESSION, SESSION]);
      should(await fixture.storage.readState(SESSION)).containDeep({
        status: 'kill_failed',
        reason: `${STOP_REASON}: ${STOP_FAILURE}`,
        finishedAt: TERMINATED_AT,
        exitCode: 137,
      });
    } finally {
      await fixture.close();
    }
  });

  it('should preserve an existing failed-stop verdict when picker recovery quarantines', async () => {
    // Arrange: the transport writes a standing failed-stop verdict between the initial runtime
    // admission and the failing picker recovery. The production atomic quarantine merge must retain
    // every terminal field even though the generic recovery patch says `failed` with a new reason.
    let beforeFailure = async () => undefined;
    const fixture = await buildFixture({
      harness: 'codex',
      pickerFailure: true,
      beforePickerFailure: async () => await beforeFailure(),
    });
    try {
      beforeFailure = async () => {
        await fixture.storage.updateState(SESSION, current => ({
          ...(current as Record<string, unknown>),
          status: 'kill_failed',
          reason: `${STOP_REASON}: ${STOP_FAILURE}`,
          finishedAt: TERMINATED_AT,
          exitCode: 137,
          terminationSignal: 'SIGKILL',
        }));
      };
      const request = {
        action: 'model',
        model: 'gpt-5.6-codex',
        effort: 'max',
      } as const satisfies RuntimeControlRequest;

      // Act
      const error = await rejected(fixture.runtime.control(SESSION, request, 'picker-fails'));

      // Assert: the picker opened once and no key followed. Recovery closed inputs and added its
      // diagnostics, while the stop verdict/reason/termination metadata remained authoritative.
      should(error).be.instanceOf(SessionRuntimeError).and.have.property('failure', 'failed');
      should(inputActions(fixture.actions)).deepEqual(['picker:open']);
      should(fixture.actions).containEql('quarantine');
      should(fixture.actions).containEql('pane:stop');
      should(await fixture.storage.readState(SESSION)).containDeep({
        status: 'kill_failed',
        reason: `${STOP_REASON}: ${STOP_FAILURE}`,
        finishedAt: TERMINATED_AT,
        exitCode: 137,
        terminationSignal: 'SIGKILL',
        health: 'crashed',
        promptReady: false,
      });
      should(
        await fixture.effects.inspect(
          { sessionId: SESSION, effectId: 'runtime:picker-fails' },
          runtimeRequestFingerprint(request),
        ),
      ).equal('unsettled');
    } finally {
      await fixture.close();
    }
  });
});
