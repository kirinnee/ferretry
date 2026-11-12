import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import { PERSON_ORIGIN, RUNTIME_START_DEADLINE_MS, type RuntimeStartResolution } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/**
 * A start that NAMES a runtime launches with that runtime's harness and login. Ferrets asks Runtimes (`runtime.start`)
 * before anything is written, so the record carries the login the launch reads: `fy new --runtime rt` and the app's
 * new-ferret are no longer launched signed out. Fake values only.
 */

/** The new ferret's id; fails the test when the start was refused. */
const startedId = (started: Awaited<ReturnType<FerretsService['start']>>) => {
  if (!started.ok) throw new Error(`the start was refused: ${started.error.reason}`);
  return started.value;
};

/** A login the owner switched off, and one over its spend budget: neither may be spent on any path. */
const OFF = 'off';
const CAPPED = 'capped';

type Resolve = (runtime: string) => Promise<RuntimeStartResolution>;

const rt: Resolve = async runtime =>
  runtime === 'rt'
    ? { ok: true, harness: 'claude-code', login: 'oauth' }
    : { ok: false, sentence: `runtime ${runtime} was not started: no runtime ${runtime} exists on this machine` };

/** A driven timer: `after` records what it was asked and `advance` fires every timer due, as the kernel clock would. */
function drivenClock() {
  const timers = new Map<number, { readonly at: number; readonly fire: () => void }>();
  let now = 0;
  let next = 0;
  return {
    after: (delayMs: number, fire: () => void) => {
      next += 1;
      const id = next;
      timers.set(id, { at: now + delayMs, fire });
      return () => {
        timers.delete(id);
      };
    },
    advance: (ms: number) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fire();
      }
    },
    pending: () => timers.size,
  };
}

function fixture(runtimeStart: Resolve | undefined = rt, after?: (delayMs: number, fire: () => void) => () => void) {
  const registry = new FerretRegistry([]);
  const harness = new FakeHarness('claude-code');
  const loginsAsked: string[] = [];
  const decided: { runtime?: string; login?: string; harness: string }[] = [];
  let next = 0;
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => {
      next += 1;
      return ferretId(`f${next}`);
    },
    newName: taken => {
      for (let n = 1; ; n += 1) if (!taken(`fern${n}`)) return `fern${n}`;
    },
    save: async () => {},
    saveTokens: async () => {},
    harness: key => (key === 'claude-code' ? harness : undefined),
    harnessKeys: () => ['claude-code'],
    runner: () => new FakeRunner(),
    decide: async input => {
      decided.push({
        harness: input.harness,
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        ...(input.login === undefined ? {} : { login: input.login }),
      });
      // Usage's `start.decide`: a login over its budget is paused, whoever asks and on whatever path.
      return input.login === CAPPED
        ? { allow: false, reason: `login "${CAPPED}" is paused: over its daily budget on this machine` }
        : { allow: true };
    },
    // Runtimes' `login` answer: a login switched off is refused (the budget is `start.decide`'s, above).
    loginStart: async login =>
      login === OFF ? { ok: false, sentence: `login ${OFF} is switched off (owner-off)` } : { ok: true },
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    // Not inside the state home: a ferret's start is judged against it.
    stateHomeHolding: async () => undefined,
    // The launch path's own read of the record's login: what proves the credential would reach the child.
    loginEnv: async login => {
      loginsAsked.push(login);
      return ok({});
    },
    ...(runtimeStart === undefined ? {} : { runtimeStart }),
    ...(after === undefined ? {} : { after }),
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  return {
    registry,
    ports,
    harness,
    loginsAsked,
    decided,
    service: new FerretsService(registry, new FerretTokenDirectory(), ports),
  };
}

describe('a start by runtime launches with the runtime’s login', () => {
  test('the record carries the runtime’s harness and login, the decision and the launch see them', async () => {
    const f = fixture();

    const started = await f.service.start({ folder: '/work', runtime: 'rt', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(true);
    const record = f.registry.get(startedId(started));
    expect(record?.runtime).toBe('rt');
    expect(record?.login).toBe('oauth');
    expect(record?.harness).toBe('claude-code');
    expect(f.decided).toEqual([{ harness: 'claude-code', runtime: 'rt', login: 'oauth' }]);
    // The launch asked the login port for the runtime's login: it is not launched signed out.
    expect(f.loginsAsked).toEqual(['oauth']);
  });

  test('the runtime is the account: its own login and its own harness may be named beside it, and they start', async () => {
    const f = fixture();

    const started = await f.service.start(
      { folder: '/work', runtime: 'rt', login: 'oauth', harness: 'claude-code', by: 'owner' },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(true);
    expect(f.registry.get(startedId(started))?.login).toBe('oauth');
    expect(f.loginsAsked).toEqual(['oauth']);
  });

  test('a login that is not the runtime’s is refused beside it, so a switched-off login is never spent through a runtime', async () => {
    const f = fixture();

    const started = await f.service.start({ folder: '/work', runtime: 'rt', login: 'off', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(false);
    expect(started.ok ? '' : started.error.reason).toBe(
      'runtime rt signs in with its own login, not off, so the ferret was not started',
    );
    expect(f.registry.list()).toEqual([]);
    expect(f.decided).toEqual([]);
    expect(f.loginsAsked).toEqual([]);
  });

  test('an explicit harness the runtime does not run is refused, naming both, before anything is written', async () => {
    const f = fixture();

    const started = await f.service.start(
      { folder: '/work', runtime: 'rt', harness: 'codex', by: 'owner' },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(false);
    expect(started.ok ? '' : started.error.reason).toMatch(/runtime rt runs the claude-code harness, not codex/u);
    expect(f.registry.list()).toEqual([]);
    expect(f.decided).toEqual([]);
  });

  test('an unknown or unservable runtime is refused with the sentence Runtimes gave: no record, no launch', async () => {
    const f = fixture();

    const started = await f.service.start({ folder: '/work', runtime: 'ghost', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(false);
    expect(started.ok ? '' : started.error.reason).toContain('ghost');
    expect(f.registry.list()).toEqual([]);
    expect(f.harness.launched).toEqual([]);
    expect(f.loginsAsked).toEqual([]);
  });

  test('a Runtimes that throws refuses the start with a fixed sentence naming the runtime', async () => {
    const f = fixture(async () => {
      throw new Error('boom with a secret-looking value');
    });

    const started = await f.service.start({ folder: '/work', runtime: 'rt', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(false);
    const reason = started.ok ? '' : started.error.reason;
    expect(reason).toContain('runtime rt could not be checked');
    expect(reason).not.toContain('boom');
    expect(f.registry.list()).toEqual([]);
  });

  test('a stopped record that has a runtime and NO login (a converted ferret) resumes signed in on the runtime’s login', async () => {
    const f = fixture();
    const id = startedId(await f.service.start({ folder: '/work', runtime: 'rt', by: 'owner' }, PERSON_ORIGIN));
    await f.service.stop(id, 'now');
    // The converter's record: a runtime, a harness, and no login.
    const { login: _login, ...converted } = f.registry.get(id)!;
    f.registry.put(converted);
    f.loginsAsked.length = 0;
    f.decided.length = 0;

    const resumed = await f.service.resume(id, undefined, { origin: PERSON_ORIGIN });

    expect(resumed.ok).toBe(true);
    expect(f.registry.get(id)?.login).toBe('oauth');
    expect(f.decided).toEqual([{ harness: 'claude-code', runtime: 'rt', login: 'oauth' }]);
    expect(f.loginsAsked).toEqual(['oauth']);
  });

  test('a resume of a record whose runtime cannot serve is refused by name and launches nothing, signed out or not', async () => {
    let serving = true;
    const f = fixture(async runtime =>
      serving
        ? { ok: true, harness: 'claude-code', login: 'oauth' }
        : { ok: false, sentence: `runtime ${runtime} was not started: its login needs signing in` },
    );
    const id = startedId(await f.service.start({ folder: '/work', runtime: 'rt', by: 'owner' }, PERSON_ORIGIN));
    await f.service.stop(id, 'now');
    const { login: _login, ...converted } = f.registry.get(id)!;
    f.registry.put(converted);
    const launches = f.harness.launched.length;
    f.loginsAsked.length = 0;
    f.decided.length = 0;
    serving = false;

    const resumed = await f.service.resume(id, undefined, { origin: PERSON_ORIGIN });

    expect(resumed.ok).toBe(false);
    expect(resumed.ok ? '' : resumed.error.reason).toContain('runtime rt was not started');
    expect(f.harness.launched).toHaveLength(launches);
    expect(f.decided).toEqual([]);
    expect(f.registry.get(id)?.state).toBe('stopped');
  });

  test('a resume of a record whose runtime now runs another harness is refused, not launched on the wrong harness', async () => {
    let harness: 'claude-code' | 'codex' = 'claude-code';
    const f = fixture(async () => ({ ok: true, harness, login: 'oauth' }));
    const id = startedId(await f.service.start({ folder: '/work', runtime: 'rt', by: 'owner' }, PERSON_ORIGIN));
    await f.service.stop(id, 'now');
    harness = 'codex';

    const resumed = await f.service.resume(id, undefined, { origin: PERSON_ORIGIN });

    expect(resumed.ok).toBe(false);
    expect(resumed.ok ? '' : resumed.error.reason).toMatch(/runtime rt runs the codex harness, not claude-code/u);
  });

  test('a resume of a record with no runtime is unchanged: its own stored login, no question asked', async () => {
    let asked = 0;
    const f = fixture(async () => {
      asked += 1;
      return { ok: false, sentence: 'never' };
    });
    const id = startedId(
      await f.service.start({ folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' }, PERSON_ORIGIN),
    );
    await f.service.stop(id, 'now');
    f.loginsAsked.length = 0;

    const resumed = await f.service.resume(id, undefined, { origin: PERSON_ORIGIN });

    expect(resumed.ok).toBe(true);
    expect(asked).toBe(0);
    expect(f.registry.get(id)?.login).toBe('gw');
    expect(f.loginsAsked).toEqual(['gw']);
  });

  test('a start that names no runtime is unchanged: its own harness and login, no question asked', async () => {
    let asked = 0;
    const f = fixture(async () => {
      asked += 1;
      return { ok: false, sentence: 'never' };
    });

    const started = await f.service.start(
      { folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(true);
    expect(asked).toBe(0);
    expect(f.registry.get(startedId(started))?.login).toBe('gw');
  });
});

/**
 * A login that is switched off or over its budget is refused on EVERY path that launches, named directly or reached through
 * a runtime, with one sentence naming the login: the switch-off by Runtimes' `login` answer (the shared resolution), the
 * budget by Usage's `start.decide`, which sees the RESOLVED login on every path. Nothing is written or launched.
 * Restart and automatic resume are `service.resume` itself (the daemon binds both to it), so their cases run it with the
 * options each passes. Fork and handover launch through seams the production assembly leaves unbound (`moves-deps.ts`:
 * lifecycle, gateway, account resolution), so no fork launch can happen yet; a move is tested in `move.test.ts`.
 */
describe('a login that may not be spent is refused on every path', () => {
  const RUNTIMES: Resolve = async runtime => {
    if (runtime === 'rt-off')
      return { ok: false, sentence: `runtime rt-off was not started: login ${OFF} is switched off (owner-off)` };
    if (runtime === 'rt-capped') return { ok: true, harness: 'claude-code', login: CAPPED };
    return runtime === 'rt'
      ? { ok: true, harness: 'claude-code', login: 'oauth' }
      : { ok: false, sentence: `no runtime ${runtime}` };
  };
  const nothingLaunched = (f: ReturnType<typeof fixture>) => {
    expect(f.harness.launched).toEqual([]);
    expect(f.registry.list()).toEqual([]);
  };

  test('start: a login switched off, named directly (--login)', async () => {
    const f = fixture(RUNTIMES);

    const started = await f.service.start(
      { folder: '/work', harness: 'claude-code', login: OFF, by: 'owner' },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(false);
    expect(started.ok ? '' : started.error.reason).toBe(`login ${OFF} is switched off (owner-off)`);
    nothingLaunched(f);
  });

  test('start: a Runtimes that cannot check the login refuses it with a fixed sentence, never the thrown text', async () => {
    const f = fixture(RUNTIMES);
    f.ports.loginStart = async () => {
      throw new Error('boom with a secret-looking value');
    };

    const started = await f.service.start(
      { folder: '/work', harness: 'claude-code', login: 'oauth', by: 'owner' },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(false);
    expect(started.ok ? '' : started.error.reason).toBe(
      'login oauth could not be checked, so the ferret was not started',
    );
    nothingLaunched(f);
  });

  test('start: a login over its budget, named directly (--login)', async () => {
    const f = fixture(RUNTIMES);

    const started = await f.service.start(
      { folder: '/work', harness: 'claude-code', login: CAPPED, by: 'owner' },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(false);
    expect(started.ok ? '' : started.error.reason).toContain(`login "${CAPPED}" is paused`);
    nothingLaunched(f);
  });

  test('start: a runtime whose login is switched off, or over its budget', async () => {
    const f = fixture(RUNTIMES);

    const off = await f.service.start({ folder: '/work', runtime: 'rt-off', by: 'owner' }, PERSON_ORIGIN);
    const capped = await f.service.start({ folder: '/work', runtime: 'rt-capped', by: 'owner' }, PERSON_ORIGIN);

    expect(off.ok ? '' : off.error.reason).toContain(`login ${OFF} is switched off`);
    expect(capped.ok ? '' : capped.error.reason).toContain(`login "${CAPPED}" is paused`);
    nothingLaunched(f);
  });

  test('sub-ferret (a ferret starting a helper, `fy new` from inside one): the same refusal', async () => {
    const f = fixture(RUNTIMES);
    const parent = startedId(await f.service.start({ folder: '/work', runtime: 'rt', by: 'owner' }, PERSON_ORIGIN));
    const launched = f.harness.launched.length;

    const direct = await f.service.start(
      { folder: '/work', harness: 'claude-code', login: OFF, parent, by: 'ferret' },
      PERSON_ORIGIN,
    );
    const viaRuntime = await f.service.start(
      { folder: '/work', runtime: 'rt-capped', parent, by: 'ferret' },
      PERSON_ORIGIN,
    );

    expect(direct.ok).toBe(false);
    expect(direct.ok ? '' : direct.error.reason).toContain(`login ${OFF} is switched off`);
    expect(viaRuntime.ok).toBe(false);
    expect(viaRuntime.ok ? '' : viaRuntime.error.reason).toContain(`login "${CAPPED}" is paused`);
    expect(f.harness.launched).toHaveLength(launched);
    expect(f.registry.list()).toHaveLength(1);
  });

  /** A stopped ferret whose record holds what the case needs; `serving` flips once it is stopped. */
  async function stoppedOn(
    f: ReturnType<typeof fixture>,
    edit: (record: NonNullable<ReturnType<typeof f.registry.get>>) => NonNullable<ReturnType<typeof f.registry.get>>,
  ) {
    const id = startedId(await f.service.start({ folder: '/work', runtime: 'rt', by: 'owner' }, PERSON_ORIGIN));
    await f.service.stop(id, 'now');
    f.registry.put(edit(f.registry.get(id)!));
    f.decided.length = 0;
    return { id, launches: f.harness.launched.length };
  }

  /** The three ways a stored record is relaunched in place: a person's resume, Restart (the daemon's), automatic resume. */
  const relaunches = {
    resume: (f: ReturnType<typeof fixture>, id: ReturnType<typeof startedId>) =>
      f.service.resume(id, undefined, { origin: PERSON_ORIGIN }),
    restart: (f: ReturnType<typeof fixture>, id: ReturnType<typeof startedId>) =>
      f.service.resume(id, undefined, { actor: 'daemon', origin: PERSON_ORIGIN }),
    'auto-resume': (f: ReturnType<typeof fixture>, id: ReturnType<typeof startedId>) =>
      f.service.resume(id, undefined, { actor: 'daemon', automatic: true, origin: PERSON_ORIGIN }),
  } as const;

  for (const [path, relaunch] of Object.entries(relaunches)) {
    test(`${path}: a record holding a login that was switched off since (no runtime) is refused, nothing launched`, async () => {
      const f = fixture(RUNTIMES);
      const { id, launches } = await stoppedOn(f, ({ runtime: _runtime, ...record }) => ({ ...record, login: OFF }));

      const resumed = await relaunch(f, id);

      expect(resumed.ok).toBe(false);
      expect(resumed.ok ? '' : resumed.error.reason).toBe(`login ${OFF} is switched off (owner-off)`);
      expect(f.harness.launched).toHaveLength(launches);
      expect(f.registry.get(id)?.state).toBe('stopped');
    });

    test(`${path}: a record holding a login now over its budget (no runtime) is refused, nothing launched`, async () => {
      const f = fixture(RUNTIMES);
      const { id, launches } = await stoppedOn(f, ({ runtime: _runtime, ...record }) => ({ ...record, login: CAPPED }));

      const resumed = await relaunch(f, id);

      expect(resumed.ok).toBe(false);
      expect(resumed.ok ? '' : resumed.error.reason).toContain(`login "${CAPPED}" is paused`);
      expect(f.harness.launched).toHaveLength(launches);
    });

    test(`${path}: a converted record (a runtime, no login) whose runtime's login is switched off, or over budget, is refused`, async () => {
      for (const runtime of ['rt-off', 'rt-capped']) {
        const f = fixture(RUNTIMES);
        const { id, launches } = await stoppedOn(f, ({ login: _login, ...record }) => ({ ...record, runtime }));

        const resumed = await relaunch(f, id);

        expect(resumed.ok, runtime).toBe(false);
        expect(resumed.ok ? '' : resumed.error.reason).toMatch(/switched off|is paused/u);
        expect(f.harness.launched).toHaveLength(launches);
        expect(f.registry.get(id)?.state).toBe('stopped');
      }
    });
  }
});

/**
 * Runtimes' `runtime.start` is a provide hook, so nothing but Ferrets bounds the wait. A resolver that never settles must
 * neither launch nor hold the ferret's lifecycle queue (a resume waits inside it, and a stop queues behind a resume).
 */
describe('a Runtimes answer that never arrives is refused in time and releases the ferret’s queue', () => {
  const settled = async <T>(work: Promise<T>): Promise<T | 'pending'> =>
    await Promise.race([work, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 20))]);

  test('a resume whose runtime resolver never settles is refused by name at the deadline, launches nothing, and a following stop settles', async () => {
    const clock = drivenClock();
    let hang = false;
    const f = fixture(async runtime => {
      if (hang) return await new Promise<RuntimeStartResolution>(() => {});
      return rt(runtime);
    }, clock.after);
    const id = startedId(await f.service.start({ folder: '/work', runtime: 'rt', by: 'owner' }, PERSON_ORIGIN));
    await f.service.stop(id, 'now');
    const launches = f.harness.launched.length;
    hang = true;

    const resuming = f.service.resume(id, undefined, { origin: PERSON_ORIGIN });
    const stopping = f.service.stop(id, 'now');
    expect(await settled(resuming)).toBe('pending');
    expect(await settled(stopping)).toBe('pending');

    clock.advance(RUNTIME_START_DEADLINE_MS);

    const resumed = await resuming;
    expect(resumed.ok).toBe(false);
    expect(resumed.ok ? '' : resumed.error.reason).toBe('could not check runtime rt in time; try again');
    expect(await settled(stopping)).not.toBe('pending');
    expect(f.harness.launched).toHaveLength(launches);
    expect(f.registry.get(id)?.state).toBe('stopped');
    expect(clock.pending()).toBe(0);
  });

  test('a start whose runtime resolver never settles is refused at the deadline and writes nothing', async () => {
    const clock = drivenClock();
    const f = fixture(async () => await new Promise<RuntimeStartResolution>(() => {}), clock.after);

    const starting = f.service.start({ folder: '/work', runtime: 'rt', by: 'owner' }, PERSON_ORIGIN);
    expect(await settled(starting)).toBe('pending');
    clock.advance(RUNTIME_START_DEADLINE_MS - 1);
    expect(await settled(starting)).toBe('pending');
    clock.advance(1);

    const started = await starting;
    expect(started.ok).toBe(false);
    expect(started.ok ? '' : started.error.reason).toBe('could not check runtime rt in time; try again');
    expect(f.registry.list()).toEqual([]);
    expect(f.harness.launched).toEqual([]);
  });

  test('a direct login check that never settles is refused at the deadline, and a late answer launches nothing', async () => {
    const clock = drivenClock();
    let answer: (resolution: { ok: true }) => void = () => {};
    const f = fixture(undefined, clock.after);
    f.ports.loginStart = async () => await new Promise<{ ok: true }>(resolve => (answer = resolve));

    const starting = f.service.start(
      { folder: '/work', harness: 'claude-code', login: 'gw', by: 'owner' },
      PERSON_ORIGIN,
    );
    expect(await settled(starting)).toBe('pending');
    clock.advance(RUNTIME_START_DEADLINE_MS);

    const started = await starting;
    expect(started.ok).toBe(false);
    expect(started.ok ? '' : started.error.reason).toBe('could not check login gw in time; try again');
    answer({ ok: true });
    await settled(Promise.resolve());
    expect(f.registry.list()).toEqual([]);
    expect(f.harness.launched).toEqual([]);
  });

  test('an answer inside the deadline is used and cancels the timer', async () => {
    const clock = drivenClock();
    const f = fixture(undefined, clock.after);

    const started = await f.service.start({ folder: '/work', runtime: 'rt', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(true);
    expect(clock.pending()).toBe(0);
  });
});
