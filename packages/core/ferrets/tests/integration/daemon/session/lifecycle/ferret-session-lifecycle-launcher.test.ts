import { describe, it } from 'bun:test';
import should from 'should';
import { err, ok } from '@ferretry/std';
import type { FerretEndCause, FerretId, Runner, RunnerHandle } from '../../../../../contract/index.ts';
import { FakeRunner, ferretId } from '../../../../../contract/testing/index.ts';
import {
  FerretSessionLifecycleLauncher,
  type FerretLaunchPorts,
  heldLifecycleLauncher,
  READY_BOUND_MS,
  READY_POLL_MS,
} from '../../../../../daemon/adapters/session/lifecycle/ferret-session-lifecycle-launcher.ts';
import { createSessionRecord } from '../../../../../daemon/lib/session/lifecycle/policy.ts';
import { defaultSessionLifecycleSettings } from '../../../../../daemon/lib/session/lifecycle/settings.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

/**
 * The lifecycle's pane launcher is a thin adapter over Ferrets' own launch and stop (the held variants) and over the
 * runner on the handle the registry holds. Fakes only: no process, no tmux, no clock beyond the one each case drives.
 */

const ID = parseSessionId('mw7bp88g-50e00159');
const record = createSessionRecord(
  { agent: '/opt/fleet/bin/claude-auto-kirin', cwd: '/workspace/project', mode: 'auto', prompt: 'work' },
  { id: ID, cwd: '/workspace/project', at: '2026-11-08T10:00:00.000Z', settings: defaultSessionLifecycleSettings },
).record;

function fixture(options: { readonly runner?: Runner | undefined; readonly handle?: RunnerHandle | undefined } = {}) {
  const runner = 'runner' in options ? options.runner : new FakeRunner();
  const calls: string[] = [];
  const stops: { ferret: FerretId; how: string; reason: string | undefined; cause: FerretEndCause }[] = [];
  let clock = 0;
  let outcome: Awaited<ReturnType<FerretLaunchPorts['launch']>> = ok(ferretId(ID));
  let refused: string | undefined;
  const ports: FerretLaunchPorts = {
    launch: async ferret => {
      calls.push(`launch ${ferret}`);
      return outcome;
    },
    stop: async (ferret, how, reason, cause) => void stops.push({ ferret, how, reason, cause }),
    refusal: async ferret => {
      calls.push(`refusal ${ferret}`);
      return refused;
    },
    handleOf: () => ('handle' in options ? options.handle : ('%1' as RunnerHandle)),
    runner: () => runner,
    sleep: async ms => {
      clock += ms;
    },
    nowMs: () => clock,
  };
  return {
    subject: new FerretSessionLifecycleLauncher(ports),
    runner: runner as FakeRunner,
    calls,
    stops,
    failLaunchWith: (reason: string) => {
      outcome = err({ reason });
    },
    refuseWith: (reason: string | undefined) => {
      refused = reason;
    },
  };
}

describe('FerretSessionLifecycleLauncher', () => {
  describe('panePid', () => {
    it('should answer the pid of the process the live pane runs, and nothing for a pane it cannot see', async () => {
      // Arrange
      const live = fixture();
      const started = await live.runner.start({ ferret: ferretId(ID) } as never);
      const handle = started.ok ? started.value.handle : undefined;
      const seen = new FerretSessionLifecycleLauncher({
        launch: async () => ok(ferretId(ID)),
        stop: async () => undefined,
        refusal: async () => undefined,
        handleOf: () => handle,
        runner: () => live.runner,
        sleep: async () => undefined,
        nowMs: () => 0,
      });

      // Act
      const pid = await seen.panePid(record);
      const none = await fixture({ handle: undefined }).subject.panePid(record);
      const gone = await fixture({ handle: '%99' as RunnerHandle }).subject.panePid(record);

      // Assert
      should(pid).equal(started.ok ? started.value.pid : undefined);
      should(pid).be.a.Number();
      should(none).be.undefined();
      should(gone).be.undefined();
    });
  });

  describe('alive', () => {
    it('should say a live pane is alive', async () => {
      // Arrange
      const f = fixture();
      const started = await f.runner.start({ ferret: ferretId(ID) } as never);
      const subject = new FerretSessionLifecycleLauncher({
        launch: async () => ok(ferretId(ID)),
        stop: async () => undefined,
        refusal: async () => undefined,
        handleOf: () => (started.ok ? started.value.handle : undefined),
        runner: () => f.runner,
        sleep: async () => undefined,
        nowMs: () => 0,
      });

      // Act / Assert
      should(await subject.alive(record)).equal(true);
    });

    it('should say a handle nothing is behind is not alive', async () => {
      // Arrange
      const f = fixture();

      // Act / Assert
      should(await f.subject.alive(record)).equal(false);
    });

    it.each([
      ['no handle', { handle: undefined }],
      ['no runner', { runner: undefined }],
    ] as const)('should say not alive with %s, and ask nothing', async (_name, options) => {
      // Arrange
      const f = fixture(options);

      // Act / Assert
      should(await f.subject.alive(record)).equal(false);
    });
  });

  describe('launch', () => {
    it("should launch through Ferrets' own launch for this ferret, and say nothing of what the pane was told", async () => {
      // Arrange
      const f = fixture();

      // Act
      const told = await f.subject.launch(record);

      // Assert
      should(f.calls).deepEqual([`launch ${ID}`]);
      should(told).equal(undefined);
    });

    it('should refuse with the launch’s own sentence when Ferrets refuses', async () => {
      // Arrange
      const f = fixture();
      f.failLaunchWith('the owner cut off this ferret; a confirmed owner resume is required');

      // Act
      const launching = f.subject.launch(record);

      // Assert
      await should(launching).rejectedWith('the owner cut off this ferret; a confirmed owner resume is required');
    });
  });

  describe('refuseLaunch', () => {
    it('should ask Ferrets, for this ferret, why a launch must be refused, and answer its sentence', async () => {
      // Arrange
      const f = fixture();
      f.refuseWith('this ferret was stopped on purpose or finished its work, so only a deliberate resume revives it');

      // Act
      const refusal = await f.subject.refuseLaunch(record);

      // Assert
      should(f.calls).deepEqual([`refusal ${ID}`]);
      should(refusal).equal(
        'this ferret was stopped on purpose or finished its work, so only a deliberate resume revives it',
      );
    });

    it('should answer nothing when Ferrets would open a pane', async () => {
      // Arrange
      const f = fixture();

      // Act
      const refusal = await f.subject.refuseLaunch(record);

      // Assert
      should(refusal).equal(undefined);
    });
  });

  describe('heldLifecycleLauncher', () => {
    /** A service whose every method but the held ones fails the test: the queued variants would wait on the lifecycle's own key. */
    function service() {
      const calls: string[] = [];
      const wrong = (name: string) => async (): Promise<never> => {
        throw new Error(`the queued ${name} was reached`);
      };
      return {
        calls,
        held: {
          launchHeld: async (ferret: FerretId) => {
            calls.push(`launchHeld ${ferret}`);
            return ok(ferret);
          },
          stopHeld: async (ferret: FerretId, how: 'polite' | 'now', reason: string | undefined) => {
            calls.push(`stopHeld ${ferret} ${how} ${String(reason)}`);
          },
          heldLaunchRefusal: async (ferret: FerretId) => {
            calls.push(`heldLaunchRefusal ${ferret}`);
            return 'refused ahead';
          },
          resume: wrong('resume'),
          start: wrong('start'),
          // The queued stop shares the held one's name prefix and its signature.
          stop: wrong('stop'),
        },
      };
    }

    const reads = {
      handleOf: () => undefined,
      runner: () => undefined,
      sleep: async () => undefined,
      nowMs: () => 0,
    };

    it('should launch, stop and ask ahead through the held variants, never the queued resume or stop', async () => {
      // Arrange
      const s = service();
      const subject = heldLifecycleLauncher(() => s.held, reads);

      // Act
      await subject.launch(record);
      await subject.stop(record);
      const refusal = await subject.refuseLaunch(record);

      // Assert
      should(s.calls).deepEqual([`launchHeld ${ID}`, `stopHeld ${ID} now undefined`, `heldLaunchRefusal ${ID}`]);
      should(refusal).equal('refused ahead');
    });

    it('should not read the service until a call is made, so the root can build the launcher before the service', async () => {
      // Arrange
      let asked = 0;
      const s = service();

      // Act
      const subject = heldLifecycleLauncher(() => {
        asked += 1;
        return s.held;
      }, reads);
      const before = asked;
      await subject.refuseLaunch(record);

      // Assert
      should(before).equal(0);
      should(asked).equal(1);
    });
  });

  describe('ready', () => {
    it('should return at once when the harness is already at a prompt', async () => {
      // Arrange — a pane that is live and at a prompt
      const f = fixture();
      let looks = 0;
      f.runner.observe = async () => {
        looks += 1;
        return { alive: true, dead: false, promptReady: true, activeWork: false };
      };

      // Act
      await f.subject.ready(record);

      // Assert
      should(looks).equal(1);
    });

    it('should wait, polling, until the harness reaches a prompt', async () => {
      // Arrange — three looks without a prompt, then one with
      const f = fixture();
      const looks = [false, false, false, true];
      f.runner.observe = async () => ({
        alive: true,
        dead: false,
        promptReady: looks.shift() ?? true,
        activeWork: false,
      });

      // Act
      await f.subject.ready(record);

      // Assert
      should(looks).have.length(0);
    });

    it('should throw when the pane ended before it was ready', async () => {
      // Arrange
      const f = fixture();
      f.runner.observe = async () => ({ alive: true, dead: true, promptReady: false, activeWork: false });

      // Act / Assert
      await should(f.subject.ready(record)).rejectedWith(
        'the harness pane ended before it was ready for its first turn',
      );
    });

    it('should throw when there is no pane to look at', async () => {
      // Arrange
      const f = fixture();
      f.runner.observe = async () => undefined;

      // Act / Assert
      await should(f.subject.ready(record)).rejectedWith(
        'the harness pane ended before it was ready for its first turn',
      );
    });

    it('should throw when the pane is no longer alive', async () => {
      // Arrange
      const f = fixture();
      f.runner.observe = async () => ({ alive: false, dead: false, promptReady: false, activeWork: false });

      // Act / Assert
      await should(f.subject.ready(record)).rejectedWith(
        'the harness pane ended before it was ready for its first turn',
      );
    });

    it('should give up after the bound when the harness never reaches a prompt', async () => {
      // Arrange
      const f = fixture();
      let looks = 0;
      f.runner.observe = async () => {
        looks += 1;
        return { alive: true, dead: false, promptReady: false, activeWork: true };
      };

      // Act
      const waiting = f.subject.ready(record);

      // Assert — the clock only moves by the polls' sleeps, so the bound is reached after bound/poll sleeps
      await should(waiting).rejectedWith('the harness was not ready for its first turn in time');
      should(looks).equal(READY_BOUND_MS / READY_POLL_MS + 1);
    });

    it('should refuse when the runner cannot look at a pane', async () => {
      // Arrange
      const f = fixture();
      (f.runner as { observe?: unknown }).observe = undefined;

      // Act / Assert
      await should(f.subject.ready(record)).rejectedWith('this runner cannot tell whether the harness is ready');
    });
  });

  describe('deliver', () => {
    it('should type the instruction through the runner, with the step that runs just before the write', async () => {
      // Arrange
      const f = fixture();
      const started = await f.runner.start({ ferret: ferretId(ID) } as never);
      const handle = started.ok ? started.value.handle : ('%0' as RunnerHandle);
      const subject = new FerretSessionLifecycleLauncher({
        launch: async () => ok(ferretId(ID)),
        stop: async () => undefined,
        refusal: async () => undefined,
        handleOf: () => handle,
        runner: () => f.runner,
        sleep: async () => undefined,
        nowMs: () => 0,
      });
      let before = 0;

      // Act
      await subject.deliver(record, 'read turn-001.md', async () => {
        before += 1;
      });
      await subject.deliver(record, 'again');

      // Assert
      should(f.runner.deliveries.map(d => d.delivery.text)).deepEqual(['read turn-001.md', 'again']);
      should(before).equal(1);
    });

    it('should refuse with no handle, and with no runner, typing nothing', async () => {
      // Arrange
      const noHandle = fixture({ handle: undefined });
      const noRunner = fixture({ runner: undefined });

      // Act / Assert
      await should(noHandle.subject.deliver(record, 'x')).rejectedWith(`session ${ID} has no terminal to use`);
      await should(noRunner.subject.deliver(record, 'x')).rejectedWith('no runner plugin is on');
    });
  });

  describe('settled', () => {
    it('should answer what the runner says of the harness’s own startup', async () => {
      // Arrange
      const f = fixture();
      (f.runner as Runner).settled = async () => 'timed-out';

      // Act / Assert
      should(await f.subject.settled(record)).equal('timed-out');
    });

    it('should say settled when the runner cannot tell', async () => {
      // Arrange
      const f = fixture();
      (f.runner as { settled?: unknown }).settled = undefined;

      // Act / Assert
      should(await f.subject.settled(record)).equal('settled');
    });
  });

  describe('snapshot and stop', () => {
    it('should leave the last screen to the service’s own stop, and stop through it now with a plain stop cause', async () => {
      // Arrange
      const f = fixture();

      // Act
      await f.subject.snapshot();
      await f.subject.stop(record);

      // Assert
      should(f.stops).deepEqual([{ ferret: ferretId(ID), how: 'now', reason: undefined, cause: { kind: 'stopped' } }]);
    });
  });
});
