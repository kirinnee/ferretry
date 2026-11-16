import { describe, expect, test } from 'bun:test';
import { ConversationIdSchema, ConversationLeaseHeldError } from '../../../../contract/conversation-lease.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { type FerretRecord, PERSON_ORIGIN } from '../../../../contract/index.ts';
import { FakeRunner, fenced, ferretId } from '../../../../contract/testing/index.ts';
import {
  claimConversationLease,
  conversationLeaseGuard,
  LEASE_UNCHECKED,
  LEASE_UNHELD,
} from '../../../../daemon/lib/ferrets/conversation-lease-guard.ts';
import type { FerretLaunchLeases } from '../../../../daemon/lib/ferrets/launch-leases.ts';
import {
  beforePane,
  GUARD_UNCHECKED,
  GUARD_UNHELD,
  type GuardVerdict,
  type LaunchGuard,
  LaunchStepRegistry,
  paneOpened,
  RESERVED_PANE_VARIABLES,
  released,
  type SessionStore,
  paneVariables,
} from '../../../../daemon/lib/ferrets/launch-steps.ts';
import { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import { additivesFixture } from './additives-fixture.ts';

/** The stores half of what a launch asks of its features: the registry's boot faults and the runner's answers. */

const store = (id: string, variable: `FY_${string}`, locate?: SessionStore['locate']): SessionStore => ({
  id,
  variable,
  locate: locate ?? (async ferret => fenced(`/sessions/${ferret}/${id}`)),
});

describe('the registry', () => {
  test('is empty and unsealed until boot says otherwise, and keeps registration order', () => {
    const registry = new LaunchStepRegistry();
    expect(registry.sealed()).toBe(false);
    expect(registry.stores()).toEqual([]);
    registry.paneVariable(store('b', 'FY_B_ONE'));
    registry.paneVariable(store('a', 'FY_A_ONE'));
    expect(registry.stores().map(held => held.id)).toEqual(['b', 'a']);
    registry.seal();
    expect(registry.sealed()).toBe(true);
  });

  test('refuses a store registered after boot sealed it, naming the store', () => {
    const registry = new LaunchStepRegistry();
    registry.seal();
    expect(() => registry.paneVariable(store('late', 'FY_LATE'))).toThrow('late');
    expect(registry.stores()).toEqual([]);
  });

  test('refuses a repeated id and a repeated variable, naming both stores', () => {
    const registry = new LaunchStepRegistry();
    registry.paneVariable(store('one', 'FY_ONE'));
    expect(() => registry.paneVariable(store('one', 'FY_OTHER'))).toThrow('two launch stores are called one');
    expect(() => registry.paneVariable(store('two', 'FY_ONE'))).toThrow('one and two both set FY_ONE');
    expect(registry.stores().map(held => held.id)).toEqual(['one']);
  });

  test.each([...RESERVED_PANE_VARIABLES])('refuses the variable a launch sets itself: %s', variable => {
    const registry = new LaunchStepRegistry();
    expect(() => registry.paneVariable(store('bad', variable as `FY_${string}`))).toThrow('a launch sets itself');
    expect(registry.stores()).toEqual([]);
  });

  test.each(['PATH', 'fy_lower', 'FY_', 'FY_HAS SPACE', 'FY-DASH'])(
    'refuses %s, which is not an FY_* name',
    variable => {
      const registry = new LaunchStepRegistry();
      expect(() => registry.paneVariable(store('bad', variable as `FY_${string}`))).toThrow('not an FY_* variable');
    },
  );
});

describe('paneVariables', () => {
  test('answers each store’s variable, asking in registration order', async () => {
    const asked: string[] = [];
    const locate =
      (name: string): SessionStore['locate'] =>
      async ferret => {
        asked.push(name);
        return fenced(`/sessions/${ferret}/${name}`);
      };
    const variables = await paneVariables(
      [store('one', 'FY_ONE', locate('one')), store('two', 'FY_TWO', locate('two'))],
      ferretId('f1'),
    );
    expect(variables).toEqual({ FY_ONE: '/sessions/f1/one', FY_TWO: '/sessions/f1/two' });
    expect(asked).toEqual(['one', 'two']);
  });

  test('a store that throws or names nothing sets no variable and never stops the next one', async () => {
    const variables = await paneVariables(
      [
        store('throws', 'FY_THROWS', async () => {
          throw new Error('FIXTURE_SECRET could not be made');
        }),
        store('nothing', 'FY_NOTHING', async () => undefined),
        store('fine', 'FY_FINE'),
      ],
      ferretId('f1'),
    );
    expect(variables).toEqual({ FY_FINE: '/sessions/f1/fine' });
  });

  test('no stores, no variables', async () => {
    expect(await paneVariables([], ferretId('f1'))).toEqual({});
  });
});

/** The GUARDS half: the checks a launch makes around every pane it opens. */

const ALLOW: GuardVerdict = { allow: true };
const record = { id: ferretId('f1') } as FerretRecord;
const before = { record, conversation: 'conv-1' };
const opened = { record, conversation: 'conv-1', pid: 4242 };

/** A guard that logs each phase it is asked and answers from `answers` (allow by default). */
const guard = (
  id: string,
  log: string[],
  answers: Partial<Record<'beforePane' | 'paneOpened', GuardVerdict | Error>> & { released?: Error } = {},
): LaunchGuard => {
  const answer = async (phase: 'beforePane' | 'paneOpened'): Promise<GuardVerdict> => {
    log.push(`${id}.${phase}`);
    const given = answers[phase];
    if (given instanceof Error) throw given;
    return given ?? ALLOW;
  };
  return {
    id,
    beforePane: async () => await answer('beforePane'),
    paneOpened: async () => await answer('paneOpened'),
    released: async () => {
      log.push(`${id}.released`);
      if (answers.released !== undefined) throw answers.released;
    },
  };
};

describe('the registry’s guards', () => {
  test('keeps registration order and refuses a repeated id or a late guard, naming it', () => {
    const registry = new LaunchStepRegistry();
    registry.guard(guard('b', []));
    registry.guard(guard('a', []));
    expect(registry.guards().map(held => held.id)).toEqual(['b', 'a']);
    expect(() => registry.guard(guard('b', []))).toThrow('two launch guards are called b');
    registry.seal();
    expect(() => registry.guard(guard('late', []))).toThrow('late');
    expect(registry.guards().map(held => held.id)).toEqual(['b', 'a']);
  });
});

describe('beforePane', () => {
  test('asks outermost first and stops at the first refusal, as it was given', async () => {
    const log: string[] = [];
    const refusal: GuardVerdict = { allow: false, code: 'refused', reason: 'held by another writer' };
    const result = await beforePane(
      [guard('outer', log), guard('middle', log, { beforePane: refusal }), guard('inner', log)],
      before,
    );
    expect(result).toEqual({ ok: false, error: { code: 'refused', reason: 'held by another writer' } });
    expect(log).toEqual(['outer.beforePane', 'middle.beforePane']);
  });

  test('a guard that throws refuses the launch with a fixed sentence and never quotes the error', async () => {
    const log: string[] = [];
    const result = await beforePane(
      [guard('throws', log, { beforePane: new Error('FIXTURE_SECRET at /home/x') }), guard('later', log)],
      before,
    );
    expect(result).toEqual({ ok: false, error: { code: 'failed', reason: GUARD_UNCHECKED } });
    expect(log).toEqual(['throws.beforePane']);
  });

  test('a NON-async guard that throws synchronously refuses with the same fixed sentence', async () => {
    const result = await beforePane(
      [
        {
          id: 'sync',
          beforePane: () => {
            throw new Error('FIXTURE_SECRET at /home/x');
          },
        },
      ],
      before,
    );
    expect(result).toEqual({ ok: false, error: { code: 'failed', reason: GUARD_UNCHECKED } });
  });

  test('allows with no guards, and skips a guard with no beforePane', async () => {
    expect((await beforePane([], before)).ok).toBe(true);
    expect((await beforePane([{ id: 'only-release', released: async () => {} }], before)).ok).toBe(true);
  });
});

describe('paneOpened', () => {
  test('asks INNERMOST first: the reverse of beforePane', async () => {
    const log: string[] = [];
    const list = [guard('outer', log), guard('inner', log)];
    await beforePane(list, before);
    await paneOpened(list, opened);
    expect(log).toEqual(['outer.beforePane', 'inner.beforePane', 'inner.paneOpened', 'outer.paneOpened']);
  });

  test('a refusal or a throw is returned only (nothing is released here) with a fixed sentence', async () => {
    const log: string[] = [];
    const refused = await paneOpened(
      [guard('outer', log), guard('inner', log, { paneOpened: { allow: false, code: 'failed', reason: 'no' } })],
      opened,
    );
    expect(refused).toEqual({ ok: false, error: { code: 'failed', reason: 'no' } });
    const thrown = await paneOpened([guard('boom', log, { paneOpened: new Error('FIXTURE_SECRET') })], opened);
    expect(thrown).toEqual({ ok: false, error: { code: 'failed', reason: GUARD_UNHELD } });
    expect(log).toEqual(['inner.paneOpened', 'boom.paneOpened']);
  });
});

describe('paneOpened (synchronous throw)', () => {
  test('a NON-async guard that throws synchronously is returned with the fixed sentence', async () => {
    const result = await paneOpened(
      [
        {
          id: 'sync',
          paneOpened: () => {
            throw new Error('FIXTURE_SECRET at /home/x');
          },
        },
      ],
      opened,
    );
    expect(result).toEqual({ ok: false, error: { code: 'failed', reason: GUARD_UNHELD } });
  });
});

describe('released', () => {
  test('a NON-async release that throws synchronously never skips the guards outside it', async () => {
    const log: string[] = [];
    await released(
      [
        {
          id: 'outer',
          released: async () => {
            log.push('outer');
          },
        },
        {
          id: 'inner',
          released: () => {
            throw new Error('sync');
          },
        },
      ],
      ferretId('f1'),
    );
    expect(log).toEqual(['outer']);
  });

  test('frees innermost first and goes on after a guard whose release throws', async () => {
    const log: string[] = [];
    await released([guard('outer', log), guard('inner', log, { released: new Error('disk gone') })], ferretId('f1'));
    expect(log).toEqual(['inner.released', 'outer.released']);
  });
});

/** A lease port that logs each call and answers from `failures`. */
const leaseFake = (log: string[], failures: Partial<Record<'claim' | 'move', Error>> = {}): FerretLaunchLeases => ({
  claimConversation: async (_ferret, conversation) => {
    log.push(`lease.claim:${conversation}`);
    if (failures.claim !== undefined) throw failures.claim;
  },
  moveConversationToPane: async (_ferret, conversation, pid) => {
    log.push(`lease.move:${conversation}:${pid}`);
    if (failures.move !== undefined) throw failures.move;
  },
  release: async () => {
    log.push('lease.release');
  },
});

describe('the conversation lease guard', () => {
  test('a new conversation leases nothing: no store call in either phase', async () => {
    const log: string[] = [];
    const lease = conversationLeaseGuard(leaseFake(log));
    expect(await lease.beforePane?.({ record, conversation: undefined })).toEqual(ALLOW);
    expect(await lease.paneOpened?.({ record, conversation: undefined, pid: 1 })).toEqual(ALLOW);
    expect(log).toEqual([]);
  });

  test('claims before, moves onto the pane’s pid after, and releases by ferret', async () => {
    const log: string[] = [];
    const lease = conversationLeaseGuard(leaseFake(log));
    await lease.beforePane?.(before);
    await lease.paneOpened?.(opened);
    await lease.released?.(ferretId('f1'));
    expect(log).toEqual(['lease.claim:conv-1', 'lease.move:conv-1:4242', 'lease.release']);
  });

  test('says who holds it when held, and its own sentences when the store fails', async () => {
    const held = new ConversationLeaseHeldError({
      v: 1,
      harness: 'claude',
      conversation: ConversationIdSchema.parse('conv-1'),
      holder: { pid: 9, session: parseSessionId('mw7bp89h-61f11260') },
      since: '2026-11-16T09:00:00.000Z',
    });
    const heldGuard = conversationLeaseGuard(leaseFake([], { claim: held, move: held }));
    const refusal: GuardVerdict = { allow: false, code: 'refused', reason: held.message };
    expect(await heldGuard.beforePane?.(before)).toEqual(refusal);
    expect(await heldGuard.paneOpened?.(opened)).toEqual(refusal);
    const broken = conversationLeaseGuard(leaseFake([], { claim: new Error('FIXTURE_SECRET'), move: new Error('x') }));
    expect(await broken.beforePane?.(before)).toEqual({ allow: false, code: 'failed', reason: LEASE_UNCHECKED });
    expect(await broken.paneOpened?.(opened)).toEqual({ allow: false, code: 'failed', reason: LEASE_UNHELD });
  });

  test('the restart hand-over re-claims through the same body', async () => {
    const log: string[] = [];
    expect(await claimConversationLease(leaseFake(log), ferretId('f1'), 'conv-9')).toEqual(ALLOW);
    expect(log).toEqual(['lease.claim:conv-9']);
  });
});

describe('the service asks the guards around its pane', () => {
  const build = (register: (registry: LaunchStepRegistry, log: string[]) => void, withLeases = true) => {
    const log: string[] = [];
    const base = additivesFixture({ empty: true });
    const registry = new LaunchStepRegistry();
    register(registry, log);
    registry.seal();
    const runner = new FakeRunner();
    const service = new FerretsService(base.registry, base.tokens, {
      ...base.ports,
      runner: () => runner,
      launchSteps: registry,
      ...(withLeases ? { leases: leaseFake(log) } : {}),
    });
    const start = async () =>
      await service.start(
        { by: 'owner', folder: '/work', harness: 'claude-code', harnessConversation: 'conv-1' },
        PERSON_ORIGIN,
      );
    return { log, base, runner, service, start };
  };

  test('feature guards nest around the lease: outer to inner before the pane, inner to outer after, and on a stop', async () => {
    const f = build((registry, log) => {
      registry.guard(guard('a', log));
      registry.guard(guard('b', log));
    });
    const started = await f.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await f.service.stop(started.value, 'now');
    expect(f.log).toEqual([
      'a.beforePane',
      'b.beforePane',
      'lease.claim:conv-1',
      'lease.move:conv-1:1001',
      'b.paneOpened',
      'a.paneOpened',
      'lease.release',
      'b.released',
      'a.released',
    ]);
  });

  test('a feature guard’s refusal ends the launch before the lease is claimed or a pane opens, and releases every guard', async () => {
    const f = build((registry, log) => {
      registry.guard(guard('a', log, { beforePane: { allow: false, code: 'refused', reason: 'not now' } }));
    });
    const started = await f.start();
    expect(started).toMatchObject({ ok: false, error: { code: 'refused', reason: 'not now' } });
    expect(f.log.filter(line => line.startsWith('lease.claim') || line.startsWith('lease.move'))).toEqual([]);
    expect(f.log).toContain('lease.release');
    expect(f.log).toContain('a.released');
  });

  test('a guard that throws refuses with the fixed sentence', async () => {
    const f = build((registry, log) => {
      registry.guard(guard('a', log, { beforePane: new Error('FIXTURE_SECRET') }));
    });
    const started = await f.start();
    expect(started).toMatchObject({ ok: false, error: { code: 'failed', reason: GUARD_UNCHECKED } });
  });

  test('no leases and no guards behave as before: the launch just opens', async () => {
    const f = build(() => {}, false);
    expect((await f.start()).ok).toBe(true);
    expect(f.log).toEqual([]);
  });
});
