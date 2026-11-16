import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { expect, test } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import type { RunnerHandle } from '../../../../contract/index.ts';
import { ferretId, T0 } from '../../../../contract/testing/index.ts';
import type { FerretSessionPort } from '../../../../daemon/lib/ferrets/service.ts';
import { additivesFixture } from './additives-fixture.ts';

const quietSession: FerretSessionPort = { prepare: async () => {}, stamp: async () => {}, carry: async () => {} };

test('mayTouch, children and harnesses answer from the registry and the harness ports', () => {
  const f = additivesFixture();
  const other = ferretId('other');
  expect(f.service.mayTouch(f.id, f.id)).toBe(true);
  expect(f.service.mayTouch(f.id, other)).toBe(false);
  expect(f.service.children(f.id)).toEqual([]);
  expect(f.service.harnesses()).toEqual(['claude-code']);
});

test('a start naming a parent that is not a ferret is refused, and nothing is started', async () => {
  const f = additivesFixture({ empty: true });
  const answer = await f.service.start({ folder: '/work', by: 'owner', parent: ferretId('ghost') }, PERSON_ORIGIN);
  expect(answer).toEqual({
    ok: false,
    error: { code: 'refused', reason: 'no ferret ghost to be the lead of this one' },
  });
  expect(f.runner.starts).toBe(0);
});

test('a start with no harness plugin on is refused as harness_unavailable', async () => {
  const f = additivesFixture({ empty: true });
  f.ports.harnessKeys = () => [];
  const answer = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
  expect(answer).toEqual({ ok: false, error: { code: 'harness_unavailable', reason: 'no harness plugin is on' } });
  expect(f.runner.starts).toBe(0);
});

test('a confirmed restore whose tokens cannot be saved puts the cut-off back and rejects', async () => {
  const f = additivesFixture();
  f.tokens.cutOff(f.id, T0);
  let saves = 0;
  f.ports.saveTokens = async () => {
    saves += 1;
    if (saves === 1) throw new Error('disk full');
  };
  await expect(f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN, confirmRestore: () => {} })).rejects.toThrow(
    'disk full',
  );
  expect(f.tokens.isCutOff(f.id)).toBe(true);
  expect(saves).toBe(2);
  expect(f.runner.starts).toBe(0);
});

test('a cut-off that lands while the start gate is deciding refuses the relaunch of a stopped ferret', async () => {
  const f = additivesFixture();
  f.ports.decide = async () => {
    f.tokens.cutOff(f.id, T0);
    return { allow: true };
  };
  const answer = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
  expect(answer).toEqual({
    ok: false,
    error: { code: 'refused', reason: 'the owner cut off this ferret; a confirmed owner resume is required' },
  });
  expect(f.runner.starts).toBe(0);
});

test('a cut-off that lands while deciding refuses a live-pane replacement before the pane is given up', async () => {
  const f = additivesFixture({ state: 'working' });
  f.ports.decide = async () => {
    f.tokens.cutOff(f.id, T0);
    return { allow: true };
  };
  const answer = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN, replaceLiveTerminal: true });
  expect(answer).toEqual({
    ok: false,
    error: { code: 'refused', reason: 'the owner cut off this ferret; a confirmed owner resume is required' },
  });
  expect(f.registry.get(f.id)?.state).toBe('working');
});

test('renaming to a callsign another agent holds says so; the ledger code decides the failure', async () => {
  const f = additivesFixture();
  f.ports.claims = {
    allocate: async () => ({ ok: false, error: { code: 'callsign_taken', message: 'internal' } }),
    release: async () => {},
  };
  const answer = await f.service.rename(f.id, { name: 'zed' });
  expect(answer.ok).toBe(false);
  if (answer.ok) return;
  expect(answer.error.failure).toBe('taken');
  expect(answer.error.message).toContain('already called');
  expect(answer.error.message).not.toContain('internal');
});

test('a rename whose record cannot be saved releases the callsign it reserved and rejects', async () => {
  const f = additivesFixture();
  const released: [string, string][] = [];
  f.ports.claims = {
    allocate: async () => ({ ok: true, claim: { callsign: 'zed' } }) as never,
    release: async (callsign, owner) => {
      released.push([callsign, owner]);
    },
  };
  f.ports.save = async () => {
    throw new Error('disk full');
  };
  await expect(f.service.rename(f.id, { name: 'zed' })).rejects.toThrow('disk full');
  expect(released).toEqual([['zed', f.id]]);
});

test('reading a conversation whose harness plugin is off is a 503 plugin_unavailable', async () => {
  const f = additivesFixture();
  const seam = (await f.service.harness(f.id))!;
  f.ports.harness = () => undefined;
  const failure = await seam.transcript.read(undefined as never, 10).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).status).toBe(503);
  expect((failure as ApiError).code).toBe('plugin_unavailable');
});

test('a move whose mover fails for any other reason rejects as it came', async () => {
  const f = additivesFixture();
  f.ports.move = async () => {
    throw new Error('mover broke');
  };
  await expect(f.service.move(f.id, 'other-runtime', { origin: PERSON_ORIGIN })).rejects.toThrow('mover broke');
});

test('a launch lets the harness use every runner member, not only start and resume', async () => {
  const f = additivesFixture();
  const original = f.harness.start.bind(f.harness);
  let aliveAnswer: boolean | undefined;
  f.harness.start = async (spec, runner, env) => {
    aliveAnswer = await runner.alive('no-such-pane' as RunnerHandle);
    return await original(spec, runner, env);
  };
  const answer = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
  expect(answer.ok).toBe(true);
  expect(aliveAnswer).toBe(false);
  expect(f.runner.starts).toBe(1);
});

test('a harness that names no conversation leaves the launched record without one', async () => {
  const f = additivesFixture({ empty: true });
  const original = f.harness.start.bind(f.harness);
  f.harness.start = async (spec, runner, env) => {
    const started = await original(spec, runner, env);
    return started.ok ? { ok: true, value: { running: started.value.running } } : started;
  };
  const answer = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
  expect(answer.ok).toBe(true);
  expect(f.registry.get(f.id)?.state).toBe('working');
  expect(f.registry.get(f.id)?.harnessConversation).toBeUndefined();
});

test('a start whose assigned task cannot be written is not started, and the pane is not left running', async () => {
  const f = additivesFixture({
    empty: true,
    session: { ...quietSession, assign: async () => await Promise.reject(new Error('disk full')) },
  });
  const answer = await f.service.start({ folder: '/work', by: 'owner', prompt: 'do the thing' }, PERSON_ORIGIN);
  expect(answer).toEqual({
    ok: false,
    error: { code: 'failed', reason: "this ferret's assigned task could not be written, so it was not started" },
  });
  expect(f.runner.starts).toBe(0);
});

test('a start with a task but no first-turn effect record is refused, quoting nothing', async () => {
  const f = additivesFixture({
    empty: true,
    session: { ...quietSession, assign: async () => 'read turn-001.md' },
  });
  const answer = await f.service.start({ folder: '/work', by: 'owner', prompt: 'do the thing' }, PERSON_ORIGIN);
  expect(answer).toEqual({
    ok: false,
    error: {
      code: 'failed',
      reason: "the ferret's first turn has no durable effect record, so it was not started",
    },
  });
});

test('resolve names the ferret an id or callsign addresses, and says unknown for one nobody holds', async () => {
  const f = additivesFixture();
  const name = f.registry.get(f.id)!.name;
  expect(await f.service.resolve(f.id)).toEqual({ kind: 'ferret', id: f.id });
  expect(await f.service.resolve(name)).toEqual({ kind: 'ferret', id: f.id });
  expect(await f.service.resolve('nobody-has-this-name')).toEqual({ kind: 'unknown' });
});

test('a sitrep for a ferret nobody holds is undefined, and asks nothing of the sources', async () => {
  const f = additivesFixture({ empty: true });
  let asked = 0;
  f.ports.sitrepSources = () => [
    {
      lines: async () => {
        asked += 1;
        return [];
      },
    },
  ];
  expect(await f.service.sitrep(ferretId('ghost'))).toBeUndefined();
  expect(asked).toBe(0);
});

test('a sitrep carries the ferret, every source’s lines in order, and the ids of its open asks', async () => {
  const f = additivesFixture();
  f.ports.sitrepSources = () => [
    { lines: async () => [{ kind: 'doing', text: 'reading the brief' }] },
    { lines: async () => [{ kind: 'note', text: 'waiting on review' }] },
  ];
  f.ports.asks = { open: async () => [{ id: 'A3' }, { id: 'A9' }] as never };

  const sitrep = await f.service.sitrep(f.id);

  expect(sitrep?.ferret.id).toBe(f.id);
  expect(sitrep?.lines).toEqual([
    { kind: 'doing', text: 'reading the brief' },
    { kind: 'note', text: 'waiting on review' },
  ]);
  expect(sitrep?.blockers).toEqual(['A3', 'A9']);
});

test('a sitrep still answers when a source or the asks cannot be read: that part is empty, the rest stands', async () => {
  const f = additivesFixture();
  f.ports.sitrepSources = () => [
    {
      lines: async () => {
        throw new Error('board is down');
      },
    },
    { lines: async () => [{ kind: 'note', text: 'still here' }] },
  ];
  f.ports.asks = {
    open: async () => {
      throw new Error('asks is down');
    },
  };

  const sitrep = await f.service.sitrep(f.id);

  expect(sitrep?.lines).toEqual([{ kind: 'note', text: 'still here' }]);
  expect(sitrep?.blockers).toEqual([]);
});

test('resolve refuses a callsign two ferrets hold, naming each by id so the sender can choose', async () => {
  const f = additivesFixture();
  const twin = ferretId('fern-twin');
  f.registry.put({ ...f.registry.get(f.id)!, name: 'zed' });
  f.registry.put({ ...f.registry.get(f.id)!, id: twin, name: 'zed' });

  const answer = await f.service.resolve('zed');

  expect(answer).toEqual({
    kind: 'ambiguous',
    message: `the name zed is held by 2 sessions on this machine: ${f.id} (stopped), ${twin} (stopped); address one by its session id`,
  });
});
