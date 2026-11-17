import { describe, expect, test } from 'bun:test';
import { err } from '@ferretry/std';
import { PERSON_ORIGIN, type RunSpec } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { InMemoryLaunchGate } from '../../../../daemon/adapters/session/resume/in-memory-launch-gate.ts';
import type { SessionId } from '../../../../daemon/lib/session-id.ts';
import { additivesFixture } from './additives-fixture.ts';

/** The shared launch gate (`SessionFiles.launchGate`) is truthful about the launches FerretsService makes. */

/** A runner that says, at the moment a pane is asked for, whether the gate shows the launch. */
class WatchingRunner extends FakeRunner {
  seen: boolean[] = [];
  constructor(private readonly watch: () => boolean) {
    super();
  }
  override async start(spec: RunSpec) {
    this.seen.push(this.watch());
    return await super.start(spec);
  }
}

function rig(options: { readonly refuse?: boolean } = {}) {
  const base = additivesFixture();
  const gate = new InMemoryLaunchGate(async () => undefined);
  const sid = base.id as unknown as SessionId;
  const runner = new WatchingRunner(() => gate.launching(sid));
  const harness = new FakeHarness();
  if (options.refuse === true) harness.start = async () => err('unavailable');
  const ports: FerretsPorts = { ...base.ports, harness: () => harness, runner: () => runner, launches: gate };
  return { ...base, gate, sid, runner, service: new FerretsService(base.registry, base.tokens, ports) };
}

describe('a launch FerretsService makes is registered in the shared launch gate', () => {
  test('should show the launch to the gate while the pane is being asked for, and release it after a resume', async () => {
    // Arrange
    const f = rig();
    expect(f.gate.launching(f.sid)).toBe(false);

    // Act
    const answer = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });

    // Assert
    expect(answer.ok).toBe(true);
    expect(f.runner.seen).toEqual([true]);
    expect(f.gate.launching(f.sid)).toBe(false);
  });

  test('should release the gate when the launch fails', async () => {
    // Arrange
    const f = rig({ refuse: true });

    // Act
    const answer = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });

    // Assert
    expect(answer.ok).toBe(false);
    expect(f.gate.launching(f.sid)).toBe(false);
  });
});
