import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeControlRequest } from '@ferretry/protocol';
import should from 'should';
import { FileSessionEffectLedger } from '../../../src/adapters/session/effects/file-session-effect-ledger.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import type { SessionEffectLedger } from '../../../src/lib/session/effects/types.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';
import {
  SessionRuntimeControlService,
  type SessionRuntimeControlPorts,
} from '../../../src/lib/session/runtime-control/service.ts';
import { SessionRuntimeError } from '../../../src/lib/session/runtime-control/types.ts';
import { sessionView } from '../../unit/runtime/mounts/support.ts';

/**
 * Production runtime replay over the production file ledger.
 *
 * This deliberately instantiates the production domain service rather than rebuilding its algorithm
 * in a test fake. The ledger is real because the fact under test has to survive a new service in a
 * new process; only the pane, journal and session-reader boundaries are observed here.
 */

const BEGUN_AT = '2026-08-06T09:00:00.000Z';
const SETTLED_AT = '2026-08-06T09:00:04.000Z';
const SESSION = parseSessionId('20260806-runtime-replay');
const REQUEST_ID = 'fork-plan-1:startup-runtime';
const REQUEST = { action: 'effort', effort: 'high' } as const satisfies RuntimeControlRequest;
/** The production tuple is `[action, effort-or-null, model-or-null]`. */
const FINGERPRINT = '["effort","high",null]';
const key = { sessionId: SESSION, effectId: `runtime:${REQUEST_ID}` } as const;

const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

interface Work {
  readonly tmux: string[];
  readonly delivery: string[];
  readonly journal: string[];
  readonly order: string[];
}

type RuntimeParts = SessionRuntimeControlPorts;

async function subject(
  label: string,
  options: {
    readonly status?: 'starting' | 'running';
    readonly drivable?: boolean;
    /** One projection read to fail, counted from one, so the response boundary can be isolated. */
    readonly failSessionReadOnceAt?: number;
  } = {},
): Promise<{
  readonly runtime: SessionRuntimeControlService;
  readonly effects: SessionEffectLedger;
  readonly serial: KeyedSerialExecutor;
  readonly work: Work;
  readonly sessionReads: () => number;
}> {
  const status = options.status ?? 'running';
  const home = await mkdtemp(join(tmpdir(), `fy-runtime-effects-${label}-`));
  directories.add(home);
  let temporary = 0;
  const work: Work = { tmux: [], delivery: [], journal: [], order: [] };
  const durableEffects = new FileSessionEffectLedger(
    id => join(home, id),
    () => {
      temporary += 1;
      return `t${temporary}`;
    },
  );
  const effects: SessionEffectLedger = {
    inspect: async (effectKey, fingerprint) => {
      work.order.push('effect:inspect');
      return await durableEffects.inspect(effectKey, fingerprint);
    },
    begin: async (effectKey, fingerprint, at) => {
      work.order.push('effect:begin');
      return await durableEffects.begin(effectKey, fingerprint, at);
    },
    settle: async (effectKey, fingerprint, at) => {
      work.order.push('effect:settle');
      await durableEffects.settle(effectKey, fingerprint, at);
    },
  };
  const serial = new KeyedSerialExecutor();
  let reads = 0;
  const lifecycle = {
    id: SESSION,
    name: 'Runtime replay',
    agent: 'claude-auto',
    command: ['/bin/claude-auto'],
    cwd: '/work/ferretry',
    mode: 'auto',
    createdAt: BEGUN_AT,
    updatedAt: BEGUN_AT,
    tmuxSession: 'fy-runtime-replay',
  } as const;

  const repository: RuntimeParts['repository'] = {
    find: reference => (reference === SESSION ? { kind: 'session', id: SESSION } : { kind: 'missing' }),
    view: async id => {
      if (id !== SESSION) return undefined;
      reads += 1;
      if (reads === options.failSessionReadOnceAt) throw new Error(`session projection read ${reads} failed`);
      return sessionView(id, { turn: reads }, { turn: reads, status });
    },
    launch: async id => (id === SESSION ? lifecycle : undefined),
    journal: async (_id, type) => {
      work.journal.push(type);
      work.order.push('journal');
    },
    quarantine: async () => undefined,
  };
  const pane: RuntimeParts['pane'] = {
    state: async (session: string) => {
      work.tmux.push(`state:${session}`);
      work.order.push('pane:state');
      return { alive: true, dead: false, promptReady: true };
    },
    stop: async (session: string) => {
      work.tmux.push(`stop:${session}`);
    },
  };
  const injector: RuntimeParts['injector'] = {
    deliver: async (session: string, text: string) => {
      work.delivery.push(`${session}:${text}`);
      work.order.push('inject');
      return 'handled-local' as const;
    },
  };

  return {
    runtime: new SessionRuntimeControlService({
      repository,
      effects,
      pane,
      injector,
      picker: () => {
        throw new Error('replay consulted the picker transport');
      },
      harness: {
        planSwitch: () => {
          if (options.drivable !== true) throw new Error('replay consulted the harness');
          return { kind: 'inject', command: '/effort high', requestedEffort: 'high', claimsOutcome: true } as const;
        },
      } as unknown as RuntimeParts['harness'],
      accounts: {
        accounts: async () => {
          if (options.drivable !== true) throw new Error('replay consulted the account inventory');
          return [
            {
              id: 'acct-claude',
              agent: 'claude-auto',
              kind: 'claude',
              mode: 'auto',
              wrapper: '/bin/claude-auto',
              home: '/fleet/homes/claude',
              displayName: 'Claude',
              defaultModel: 'claude-opus-5',
              models: [{ id: 'claude-opus-5', available: true as const }],
              available: true,
              unavailableReason: null,
            },
          ];
        },
      } as unknown as RuntimeParts['accounts'],
      catalog: {
        get: async () => {
          throw new Error('replay consulted the runtime catalog');
        },
      } as unknown as RuntimeParts['catalog'],
      serial,
      sleeper: { sleep: async () => undefined },
      clock: { now: () => BEGUN_AT },
      clientName: 'fy',
    }),
    effects,
    serial,
    work,
    sessionReads: () => reads,
  };
}

async function refusal(run: () => Promise<unknown>): Promise<SessionRuntimeError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SessionRuntimeError) return error;
    throw error;
  }
  throw new Error('expected the runtime control to be refused, but it resolved');
}

describe('production session runtime effect replay', () => {
  it('should answer a settled replay from a fresh session view without touching the pane or journal', async () => {
    // Arrange: seed exactly the key and opaque tuple the production runtime owns.
    const fixture = await subject('settled');
    await fixture.effects.begin(key, FINGERPRINT, BEGUN_AT);
    await fixture.effects.settle(key, FINGERPRINT, SETTLED_AT);

    // Act: each replay must read the session again, not return a view retained beside the effect.
    const first = await fixture.runtime.control(SESSION, REQUEST, REQUEST_ID);
    const second = await fixture.runtime.control(SESSION, REQUEST, REQUEST_ID);

    // Assert
    should(first.config.turn).equal(1);
    should(second.config.turn).equal(2);
    should(first === second).equal(false);
    should(fixture.sessionReads()).equal(2);
    should(fixture.work.tmux).eql([]);
    should(fixture.work.delivery).eql([]);
    should(fixture.work.journal).eql([]);
  });

  it('should refuse an unsettled replay without risking a second pane effect', async () => {
    // Arrange: begun means the original attempt may already have crossed the pane boundary.
    const fixture = await subject('unsettled');
    await fixture.effects.begin(key, FINGERPRINT, BEGUN_AT);

    // Act
    const error = await refusal(async () => await fixture.runtime.control(SESSION, REQUEST, REQUEST_ID));

    // Assert: state the ambiguity accurately and leave every irreversible boundary untouched.
    should(error.failure).equal('unsettled');
    should(error.message).match(/pane may have been touched/u);
    should(fixture.sessionReads()).equal(0);
    should(fixture.work.tmux).eql([]);
    should(fixture.work.delivery).eql([]);
    should(fixture.work.journal).eql([]);
  });

  it('should conflict when the same effect key carries a different production tuple', async () => {
    // Arrange
    const fixture = await subject('conflict');
    await fixture.effects.begin(key, FINGERPRINT, BEGUN_AT);

    // Act
    const error = await refusal(
      async () => await fixture.runtime.control(SESSION, { action: 'effort', effort: 'xhigh' }, REQUEST_ID),
    );

    // Assert
    should(error.failure).equal('conflict');
    should(error.message).match(/different runtime control/u);
    should(fixture.sessionReads()).equal(0);
    should(fixture.work.tmux).eql([]);
    should(fixture.work.delivery).eql([]);
    should(fixture.work.journal).eql([]);
  });

  it('should settle before a transient closing-view failure and replay without repeating the pane act', async () => {
    // Arrange: read one is the precondition view; read two is the response projection after the
    // irreversible command and its durable journal event have both completed.
    const fixture = await subject('closing-view-failure', { drivable: true, failSessionReadOnceAt: 2 });

    // Act: the first response is lost at its final projection, then the caller retries the same id.
    const first = await refusal(async () => await fixture.runtime.control(SESSION, REQUEST, REQUEST_ID));
    const replayed = await fixture.runtime.control(SESSION, REQUEST, REQUEST_ID);

    // Assert: completion was already settled before the transient read failed. The replay therefore
    // reads the current view and performs neither a second command nor a second journal append.
    should(first.failure).equal('failed');
    should(await fixture.effects.inspect(key, FINGERPRINT)).equal('settled');
    should(replayed.config.turn).equal(3);
    should(fixture.sessionReads()).equal(3);
    should(fixture.work.delivery).eql(['fy-runtime-replay:/effort high']);
    should(fixture.work.journal).eql(['control.runtime_model']);
    should(fixture.work.order.slice(0, 3)).eql(['effect:inspect', 'effect:inspect', 'pane:state']);
  });
});

describe('startup and public runtime isolation', () => {
  it('should refuse a public control on a prompt-ready starting session without spending an effect id', async () => {
    // Arrange: the exact window a fork occupies — launched, prompt-ready, not yet running.
    const fixture = await subject('public-on-starting', { status: 'starting', drivable: true });

    // Act
    const error = await refusal(async () => await fixture.runtime.control(SESSION, REQUEST, REQUEST_ID));

    // Assert: refused on STATUS, before the ledger is touched. An id left unspent is what lets the
    // caller retry once the session is genuinely running, and no pane act happened at all.
    should(error.failure).equal('refused');
    should(error.message).match(/requires a running session, and this one is starting/u);
    should(await fixture.effects.inspect(key, FINGERPRINT)).equal('unclaimed');
    should(fixture.work.delivery).eql([]);
    should(fixture.work.journal).eql([]);
  });

  it('should refuse a startup control once the session is running', async () => {
    // Arrange: the inverse gate. Startup exists for one window and must not reach outside it.
    const fixture = await subject('startup-on-running', { status: 'running', drivable: true });

    // Act
    const error = await refusal(
      async () =>
        await fixture.serial.run(
          SESSION,
          async () => await fixture.runtime.startupWhileHeld(SESSION, REQUEST, REQUEST_ID),
        ),
    );

    // Assert
    should(error.failure).equal('refused');
    should(error.message).match(/still starting, and this one is running/u);
    should(await fixture.effects.inspect(key, FINGERPRINT)).equal('unclaimed');
    should(fixture.work.delivery).eql([]);
  });

  it('should let the startup path drive the pane exactly once and settle its effect', async () => {
    // Arrange
    const fixture = await subject('startup-drives', { status: 'starting', drivable: true });

    // Act
    await fixture.serial.run(SESSION, async () => await fixture.runtime.startupWhileHeld(SESSION, REQUEST, REQUEST_ID));

    // Assert: one injection, one journal act, and the durable effect closed so a replay resumes.
    should(fixture.work.delivery).eql(['fy-runtime-replay:/effort high']);
    should(fixture.work.journal).eql(['control.runtime_model']);
    should(await fixture.effects.inspect(key, FINGERPRINT)).equal('settled');
    should(fixture.work.order.slice(0, 6)).eql([
      'effect:inspect',
      'pane:state',
      'effect:begin',
      'inject',
      'journal',
      'effect:settle',
    ]);
    should(fixture.work.order.filter(item => item === 'effect:settle')).have.length(1);
  });

  it('should admit exactly one pane act when a public control is scheduled before the startup', async () => {
    // Arrange: distinct request ids, because two different callers are asking for two different acts.
    const fixture = await subject('public-then-startup', { status: 'starting', drivable: true });

    // Act
    const error = await refusal(async () => await fixture.runtime.control(SESSION, REQUEST, 'operator-1'));
    await fixture.serial.run(SESSION, async () => await fixture.runtime.startupWhileHeld(SESSION, REQUEST, REQUEST_ID));

    // Assert: the public call refused on status and spent nothing; only the startup touched the pane.
    should(error.failure).equal('refused');
    should(await fixture.effects.inspect({ sessionId: SESSION, effectId: 'runtime:operator-1' }, FINGERPRINT)).equal(
      'unclaimed',
    );
    should(fixture.work.delivery).have.length(1);
    should(fixture.work.journal).eql(['control.runtime_model']);
  });

  it('should admit exactly one pane act when the startup is scheduled first', async () => {
    // Arrange: the inverse order, so what is proved is the shared status gate rather than a lucky
    // interleaving. The session is still `starting` — the lifecycle has not reached turn one yet.
    const fixture = await subject('startup-then-public', { status: 'starting', drivable: true });

    // Act
    await fixture.serial.run(SESSION, async () => await fixture.runtime.startupWhileHeld(SESSION, REQUEST, REQUEST_ID));
    const error = await refusal(async () => await fixture.runtime.control(SESSION, REQUEST, 'operator-1'));

    // Assert
    should(error.failure).equal('refused');
    should(fixture.work.delivery).have.length(1);
    should(fixture.work.journal).eql(['control.runtime_model']);
  });

  it('should race a public control against the startup and still perform one act', async () => {
    // Arrange: both submitted together, so the scheduler decides the order rather than the test.
    const fixture = await subject('raced', { status: 'starting', drivable: true });

    // Act
    const outcomes = await Promise.allSettled([
      fixture.runtime.control(SESSION, REQUEST, 'operator-1'),
      fixture.serial.run(SESSION, async () => await fixture.runtime.startupWhileHeld(SESSION, REQUEST, REQUEST_ID)),
    ]);

    // Assert: whichever ran first, the public one is refused and the pane is driven once.
    should(outcomes[0]?.status).equal('rejected');
    should(outcomes[1]?.status).equal('fulfilled');
    should(fixture.work.delivery).have.length(1);
    should(fixture.work.journal).eql(['control.runtime_model']);
  });

  it('should resume a settled startup replay and refuse an unsettled one, without a second act', async () => {
    // Arrange
    const settled = await subject('startup-settled', { status: 'starting', drivable: true });
    await settled.effects.begin(key, FINGERPRINT, BEGUN_AT);
    await settled.effects.settle(key, FINGERPRINT, SETTLED_AT);
    const unsettled = await subject('startup-unsettled', { status: 'starting', drivable: true });
    await unsettled.effects.begin(key, FINGERPRINT, BEGUN_AT);

    // Act
    await settled.serial.run(SESSION, async () => await settled.runtime.startupWhileHeld(SESSION, REQUEST, REQUEST_ID));
    const error = await refusal(
      async () =>
        await unsettled.serial.run(
          SESSION,
          async () => await unsettled.runtime.startupWhileHeld(SESSION, REQUEST, REQUEST_ID),
        ),
    );

    // Assert: a settled startup is a boundary already crossed; an unsettled one may have reached the
    // pane and must never be repeated. Neither drives anything.
    should(settled.work.delivery).eql([]);
    should(settled.work.journal).eql([]);
    should(error.failure).equal('unsettled');
    should(unsettled.work.delivery).eql([]);
    should(unsettled.work.journal).eql([]);
    should(settled.sessionReads()).equal(1);
    should(settled.work.order.filter(item => item === 'effect:settle')).have.length(1);
    should(unsettled.work.order).eql(['effect:begin', 'effect:inspect']);
  });
});
