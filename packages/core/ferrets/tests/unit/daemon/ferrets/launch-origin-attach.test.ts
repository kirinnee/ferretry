import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import {
  AGENT_ORIGIN,
  DAEMON_ORIGIN,
  type FerretBirth,
  type LaunchOrigin,
  PERSON_ORIGIN,
} from '../../../../contract/index.ts';
import { ferretId } from '../../../../contract/testing/index.ts';
import { ferretsMoveResume } from '../../../../daemon/lib/ferrets/move-resume.ts';
import { ferretsPort } from '../../../../daemon/lib/ferrets/port.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * An attach (an adoption of a live pane) may only TIGHTEN a ferret's birth, never loosen it, and this is driven through
 * the consumer port (`FerretsApi.attach`), the supported entry other plugins call:
 *  - a record that has a birth keeps it, whoever attaches;
 *  - a birthless record attached by an AGENT origin becomes `agent`;
 *  - a birthless record attached by a PERSON or the DAEMON stays birthless, so it stays fenced.
 */
const REFUSED_NO_BIRTH = /does not say who first started it/u;

describe('a birthless record attached through the consumer port', () => {
  const unfenced: readonly [string, LaunchOrigin][] = [
    ['a person', PERSON_ORIGIN],
    ['the daemon', DAEMON_ORIGIN],
  ];
  for (const [who, origin] of unfenced)
    test(`${who}: stays birthless, so a person resume into the state home starts nothing`, async () => {
      const f = additivesFixture({ birth: 'missing' });
      const port = ferretsPort(f.service, 'conversation');
      expect((await port.attach(f.id, f.runner.adoptable(f.id), origin)).ok).toBe(true);
      expect(f.registry.get(f.id)?.birth).toBeUndefined();
      await f.service.stop(f.id, 'now');
      f.ports.bindFolder = async () => ok({ insideStateHome: true, verify: async () => ok(undefined) });
      const resumed = await port.resume(f.id, undefined, { origin: PERSON_ORIGIN });
      expect(resumed.ok).toBe(false);
      if (!resumed.ok) expect(resumed.error.reason).toMatch(REFUSED_NO_BIRTH);
      expect(f.runner.starts).toBe(0);
    });

  for (const [who, origin] of [
    ['an agent with no ferret', AGENT_ORIGIN],
    ['a ferret', { kind: 'agent', ferret: ferretId('lead') }],
  ] as const)
    test(`${who}: tightens it to agent`, async () => {
      const f = additivesFixture({ birth: 'missing' });
      expect((await ferretsPort(f.service, 'conversation').attach(f.id, f.runner.adoptable(f.id), origin)).ok).toBe(
        true,
      );
      expect(f.registry.get(f.id)?.birth).toBe('agent');
    });
});

describe('a record that has a birth keeps it, whoever attaches', () => {
  const births: readonly FerretBirth[] = ['person', 'daemon', 'agent'];
  const origins: readonly [string, LaunchOrigin][] = [
    ['a person', PERSON_ORIGIN],
    ['the daemon', DAEMON_ORIGIN],
    ['an agent', AGENT_ORIGIN],
  ];
  for (const birth of births)
    for (const [who, origin] of origins)
      test(`${birth}-born attached by ${who} stays ${birth}`, async () => {
        const f = additivesFixture({ birth });
        expect((await ferretsPort(f.service, 'conversation').attach(f.id, f.runner.adoptable(f.id), origin)).ok).toBe(
          true,
        );
        expect(f.registry.get(f.id)?.birth).toBe(birth);
      });
});

describe('a SUCCESSFUL project-folder move (the retarget) keeps the birth it found', () => {
  const policy = { automatic: false, dedupeSharedRecoveryScope: false, replaceLiveTerminal: true } as const;
  const target = async () => ({ runtime: 'claude-two', harness: 'claude-code' as const, conversation: 'conv-fern' });
  const cases: readonly [string, 'agent' | 'daemon' | 'missing'][] = [
    ['agent-born', 'agent'],
    ['daemon-born', 'daemon'],
    ['birthless', 'missing'],
  ];
  for (const [who, birth] of cases)
    test(`${who}: the move relaunches in an ordinary folder and the record keeps ${birth === 'missing' ? 'no birth' : birth}`, async () => {
      const f = additivesFixture({ birth });
      await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });
      const before = f.runner.starts;
      const resume = ferretsMoveResume(f.service, ferret => f.registry.get(ferret), target);
      expect((await resume.resume({ origin: PERSON_ORIGIN, id: f.id as never, policy })).disposition).toBe('revived');
      expect(f.runner.starts).toBe(before + 1);
      expect(f.registry.get(f.id)?.runtime).toBe('claude-two');
      expect(f.registry.get(f.id)?.birth).toBe(birth === 'missing' ? undefined : birth);
    });
});
