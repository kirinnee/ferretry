import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import { PERSON_ORIGIN, type RuntimeStartResolution } from '../../../../contract/index.ts';
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

type Resolve = (runtime: string) => Promise<RuntimeStartResolution>;

const rt: Resolve = async runtime =>
  runtime === 'rt'
    ? { ok: true, harness: 'claude-code', login: 'oauth' }
    : { ok: false, sentence: `runtime ${runtime} was not started: no runtime ${runtime} exists on this machine` };

function fixture(runtimeStart: Resolve | undefined = rt) {
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
      return { allow: true };
    },
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    // The launch path's own read of the record's login: what proves the credential would reach the child.
    loginEnv: async login => {
      loginsAsked.push(login);
      return ok({});
    },
    ...(runtimeStart === undefined ? {} : { runtimeStart }),
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  return {
    registry,
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

  test('an explicit login wins over the runtime’s; an explicit harness that is the runtime’s is accepted', async () => {
    const f = fixture();

    const started = await f.service.start(
      { folder: '/work', runtime: 'rt', login: 'other', harness: 'claude-code', by: 'owner' },
      PERSON_ORIGIN,
    );

    expect(started.ok).toBe(true);
    expect(f.registry.get(startedId(started))?.login).toBe('other');
    expect(f.loginsAsked).toEqual(['other']);
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
