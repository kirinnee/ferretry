import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import {
  AGENT_ORIGIN,
  DAEMON_ORIGIN,
  type FerretId,
  type LaunchOrigin,
  PERSON_ORIGIN,
} from '../../../../contract/index.ts';
import { ferretId } from '../../../../contract/testing/index.ts';
import { ferretsMoveResume } from '../../../../daemon/lib/ferrets/move-resume.ts';
import type { BoundLaunchFolder } from '../../../../daemon/lib/ferrets/service.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * EVERY launch entry takes the origin it is for, and the state-home policy follows the ORIGIN: a folder inside the state
 * home is refused to an agent (with or without a ferret behind it) and launched for a person and for the daemon's own
 * recovery. The refusal comes before the runner is asked, so nothing starts.
 */
const STATE_HOME: BoundLaunchFolder = { insideStateHome: true, verify: async () => ok(undefined) };
const REFUSED = /never starts a session inside this daemon's state home/u;

const agents: readonly [string, LaunchOrigin][] = [
  ['an agent with no ferret (the Warden)', AGENT_ORIGIN],
  ['a ferret', { kind: 'agent', ferret: ferretId('lead') }],
];
const unfenced: readonly [string, LaunchOrigin][] = [
  ['a person', PERSON_ORIGIN],
  ['the daemon’s own recovery', DAEMON_ORIGIN],
];

const insideStateHome = (f: ReturnType<typeof additivesFixture>): void => {
  f.ports.bindFolder = async () => ok(STATE_HOME);
};

describe('start', () => {
  for (const [who, origin] of agents)
    test(`${who}: a start into the state home is refused and nothing starts`, async () => {
      const f = additivesFixture({ empty: true });
      insideStateHome(f);
      const started = await f.service.start({ folder: '/work', by: 'owner' }, origin);
      expect(started.ok).toBe(false);
      if (!started.ok) expect(started.error.reason).toMatch(REFUSED);
      expect(f.runner.starts).toBe(0);
    });

  for (const [who, origin] of unfenced)
    test(`${who}: a start into the state home is launched`, async () => {
      const f = additivesFixture({ empty: true });
      insideStateHome(f);
      expect((await f.service.start({ folder: '/work', by: 'owner' }, origin)).ok).toBe(true);
      expect(f.runner.starts).toBe(1);
    });

  test('the asker word `by` is attribution: an agent’s origin on by:owner is fenced, a person’s origin on by:ferret is not', async () => {
    const fenced = additivesFixture({ empty: true });
    insideStateHome(fenced);
    expect((await fenced.service.start({ folder: '/work', by: 'owner' }, AGENT_ORIGIN)).ok).toBe(false);
    const open = additivesFixture({ empty: true });
    insideStateHome(open);
    expect((await open.service.start({ folder: '/work', by: 'ferret' }, PERSON_ORIGIN)).ok).toBe(true);
  });
});

describe('resume', () => {
  for (const [who, origin] of agents)
    test(`${who}: a resume into the state home is refused and nothing starts`, async () => {
      const f = additivesFixture();
      insideStateHome(f);
      const resumed = await f.service.resume(f.id, undefined, { origin });
      expect(resumed.ok).toBe(false);
      if (!resumed.ok) expect(resumed.error.reason).toMatch(REFUSED);
      expect(f.runner.starts).toBe(0);
    });

  for (const [who, origin] of unfenced)
    test(`${who}: a resume into the state home is launched`, async () => {
      const f = additivesFixture();
      insideStateHome(f);
      expect((await f.service.resume(f.id, undefined, { origin })).ok).toBe(true);
      expect(f.runner.starts).toBe(1);
    });

  test('the attribution actor is not authority: actor peer or warden never turns an origin into another', async () => {
    const f = additivesFixture();
    insideStateHome(f);
    for (const actor of ['peer', 'warden', 'daemon'] as const)
      expect((await f.service.resume(f.id, undefined, { origin: AGENT_ORIGIN, actor })).ok).toBe(false);
    expect(f.runner.starts).toBe(0);
    expect((await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN, actor: 'peer' })).ok).toBe(true);
  });

  test('a bind that cannot be checked refuses whatever the origin', async () => {
    const f = additivesFixture();
    f.ports.bindFolder = async () => err('no');
    for (const origin of [AGENT_ORIGIN, PERSON_ORIGIN])
      expect((await f.service.resume(f.id, undefined, { origin })).ok).toBe(false);
    expect(f.runner.starts).toBe(0);
  });
});

describe('a move’s relaunch', () => {
  const policy = { automatic: false, dedupeSharedRecoveryScope: false, replaceLiveTerminal: true } as const;
  const target = async () => ({ runtime: 'claude-two', harness: 'claude-code' as const, conversation: 'conv-fern' });

  for (const [who, origin] of agents)
    test(`${who}: the relaunch is fenced as the origin the route admitted, and the old pane keeps running`, async () => {
      const f = additivesFixture();
      await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
      insideStateHome(f);
      const before = f.runner.starts;
      const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), target);
      await expect(resume.resume({ origin, id: f.id as never, policy })).rejects.toThrow(REFUSED);
      expect(f.runner.starts).toBe(before);
    });

  test('a person’s move relaunches', async () => {
    const f = additivesFixture();
    await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
    insideStateHome(f);
    const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), target);
    expect((await resume.resume({ origin: PERSON_ORIGIN, id: f.id as never, policy })).disposition).toBe('revived');
    expect(f.runner.starts).toBe(2);
  });

  test('the binding FAILS CLOSED without an origin (or with one that is not a LaunchOrigin): nothing is launched', async () => {
    const f = additivesFixture();
    await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
    const before = f.runner.starts;
    const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), target);
    for (const origin of [undefined, null, 'owner', {}, { kind: 'owner' }])
      await expect(
        resume.resume({ origin, id: f.id as never, policy } as unknown as Parameters<typeof resume.resume>[0]),
      ).rejects.toThrow(/did not say who it is relaunching for/u);
    expect(f.runner.starts).toBe(before);
  });
});

test('the ferret id in an agent origin names the caller and gates nothing', async () => {
  const f = additivesFixture();
  insideStateHome(f);
  const named: FerretId = ferretId('someone-else');
  expect((await f.service.resume(f.id, undefined, { origin: { kind: 'agent', ferret: named } })).ok).toBe(false);
});
