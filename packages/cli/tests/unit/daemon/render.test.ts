import { describe, it } from 'bun:test';
import should from 'should';
import {
  decideDaemonStatus,
  renderDaemonStatus,
  renderDaemonStatusJson,
  renderInstalled,
  statusExitCode,
} from '../../../src/lib/daemon/render';
import { absentReport, health, liveness, runningReport, stoppedReport } from './fixtures';

describe('status decision', () => {
  it('should call the daemon serving whenever its API answered', () => {
    // Act
    const actual = decideDaemonStatus('fyd', absentReport, health());

    // Assert — the HTTP API is ground truth; a unit-only check false-negatives a hand-started daemon.
    should(actual.reachability).equal('serving');
    should(actual.health?.pid).equal(4242);
  });

  it('should call a supervised daemon that answered nothing at all wedged', () => {
    // Act
    const actual = decideDaemonStatus('fyd', runningReport, undefined);

    // Assert
    should(actual.reachability).equal('wedged');
    should(actual.health).be.undefined();
  });

  it('should call a daemon whose liveness answer says so starting, and one whose report timed out busy', () => {
    // Act
    const starting = decideDaemonStatus('fyd', runningReport, undefined, liveness());
    const busy = decideDaemonStatus('fyd', runningReport, undefined, liveness({ status: 'ok' }));
    const serving = decideDaemonStatus('fyd', runningReport, health(), liveness({ status: 'ok' }));

    // Assert — "process exists but its API is unavailable" used to be all three.
    should(starting.reachability).equal('starting');
    should(starting.liveness?.boot?.step).equal('first self-check (reconciling the session index)');
    should(busy.reachability).equal('busy');
    should(serving.reachability).equal('serving');
    should(serving.liveness?.status).equal('ok');
  });

  it('should call a daemon nothing can find stopped', () => {
    // Act
    const actual = decideDaemonStatus('fyd', stoppedReport, undefined);

    // Assert
    should(actual.reachability).equal('stopped');
  });
});

describe('status exit code', () => {
  it('should succeed only when the daemon is actually usable', () => {
    // Act + Assert
    should(statusExitCode(decideDaemonStatus('fyd', runningReport, health()))).equal(0);
    should(statusExitCode(decideDaemonStatus('fyd', runningReport, undefined))).equal(1);
    should(statusExitCode(decideDaemonStatus('fyd', stoppedReport, undefined))).equal(1);
    should(statusExitCode(decideDaemonStatus('fyd', runningReport, undefined, liveness()))).equal(1);
  });
});

describe('human status rendering', () => {
  it('should lead with the verdict and summarise the health the daemon reported', () => {
    // Act
    const actual = renderDaemonStatus(decideDaemonStatus('fyd', runningReport, health()), 'fy');

    // Assert — kteam printed a raw 20-key JSON object and nothing else.
    should(actual).startWith('fyd is serving\n');
    should(actual).containEql('version 1.2.3   pid 4242   bootstrap complete');
    should(actual).containEql('sessions 3 (2 running, 0 unmonitored)');
    should(actual).containEql('event-loop lag 1.3ms   wedged 0');
    should(actual).containEql('systemd: running');
  });

  it('should mark a degraded bootstrap, because "complete" alone would hide it', () => {
    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus('fyd', runningReport, health({ bootstrapState: 'degraded', bootstrapDegraded: true })),
      'fy',
    );

    // Assert
    should(actual).containEql('bootstrap degraded (degraded)');
  });

  it('should call a silent process wedged and name the restart that replaces it', () => {
    // Act
    const actual = renderDaemonStatus(decideDaemonStatus('fyd', runningReport, undefined), 'fy');

    // Assert
    should(actual).startWith('fyd process exists (pid 4242) but answered nothing in time');
    should(actual).containEql('`fy daemon restart` replaces it');
    should(actual).containEql('`fy daemon logs`');
  });

  it('should omit the pid when the supervisor did not report one', () => {
    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus('fyd', { manager: 'launchd', state: 'running' }, undefined),
      'fy',
    );

    // Assert
    should(actual).startWith('fyd process exists but answered nothing in time');
  });

  it('should name the boot step a starting daemon is on and how long it has taken', () => {
    // Act
    const actual = renderDaemonStatus(decideDaemonStatus('fyd', runningReport, undefined, liveness()), 'fy');

    // Assert
    should(actual).startWith(
      'fyd is starting (pid 9001) — first self-check (reconciling the session index), 8s on this step, 12s since it started',
    );
    should(actual).not.containEql('daemon restart');
  });

  it('should call a step that has run for minutes stuck, and say how to restart it', () => {
    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus(
        'fyd',
        runningReport,
        undefined,
        liveness({
          boot: {
            phase: 'starting',
            step: 'opening the pairing identity',
            stepElapsedSeconds: 400,
            elapsedSeconds: 401,
          },
        }),
      ),
      'fy',
    );

    // Assert
    should(actual).containEql('that step has run for over 120s');
    should(actual).containEql('`fy daemon restart` starts it again');
  });

  it('should report a starting daemon that did not say its step', () => {
    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus('fyd', { manager: 'direct', state: 'stopped' }, undefined, {
        status: 'starting',
        version: '1.2.3',
        uptimeSeconds: 3,
      }),
      'fy',
    );

    // Assert
    should(actual).startWith('fyd is starting — its boot step is not reported');
  });

  it('should call a daemon that answers liveness but not its report busy, with the stall it saw', () => {
    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus(
        'fyd',
        runningReport,
        undefined,
        liveness({
          status: 'ok',
          eventLoop: {
            lagMs: 2_400,
            maxLagMs: 366_900,
            stalls: 3,
            lastStall: { at: '2026-10-21T08:00:00.000Z', durationMs: 2_400, during: ['session listing'] },
          },
        }),
      ),
      'fy',
    );

    // Assert
    should(actual).startWith('fyd is up (pid 9001) but busy');
    should(actual).containEql(
      'event loop stalled 3x, worst 366.9s; last 2.4s at 2026-10-21T08:00:00.000Z during session listing',
    );
  });

  it('should add the last stall under a serving daemon, and nothing when it never stalled', () => {
    // Act
    const stalled = renderDaemonStatus(
      decideDaemonStatus(
        'fyd',
        runningReport,
        health(),
        liveness({
          status: 'ok',
          eventLoop: {
            lagMs: 0,
            maxLagMs: 900,
            stalls: 1,
            lastStall: { at: '2026-10-21T08:00:00.000Z', durationMs: 900, during: [] },
          },
        }),
      ),
      'fy',
    );
    const calm = renderDaemonStatus(
      decideDaemonStatus('fyd', runningReport, health(), liveness({ status: 'ok' })),
      'fy',
    );

    // Assert
    should(stalled).containEql('event loop stalled 1x, worst 0.9s; last 0.9s at 2026-10-21T08:00:00.000Z\n');
    should(calm).not.containEql('stalled');
  });

  it('should name the innermost work and the hot stack of the last stall, and the worst one apart', () => {
    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus(
        'fyd',
        runningReport,
        health(),
        liveness({
          status: 'ok',
          eventLoop: {
            lagMs: 0,
            maxLagMs: 14_300,
            stalls: 46,
            lastStall: {
              at: '2026-10-21T17:29:17.926Z',
              durationMs: 1_300,
              during: ['fleet refresh', 'fleet refresh › usage feed', 'turn watcher'],
              innermost: ['fleet refresh › usage feed', 'turn watcher'],
              stacks: [{ stack: 'newestFromEnd (fleet/src/adapters/rollout-rate-limits.ts:150)', share: 0.81 }],
            },
            worstStall: {
              at: '2026-10-21T17:20:00.000Z',
              durationMs: 14_300,
              during: ['analytics ingest'],
              innermost: [],
              stacks: [{ stack: 'parse (daemon/src/lib/transcript/claude.ts:300)', share: 0.9 }],
            },
          },
        }),
      ),
      'fy',
    );

    // Assert — the deepest labels, not every loop in flight; and the worst says what it was.
    should(actual).containEql(
      'last 1.3s at 2026-10-21T17:29:17.926Z during fleet refresh › usage feed, turn watcher\n' +
        '    last: 81% in newestFromEnd (fleet/src/adapters/rollout-rate-limits.ts:150)\n' +
        '  worst stall 14.3s at 2026-10-21T17:20:00.000Z during analytics ingest\n' +
        '    worst: 90% in parse (daemon/src/lib/transcript/claude.ts:300)',
    );
  });

  it('should not repeat the worst stall when it is the last one', () => {
    // Arrange
    const stall = { at: '2026-10-21T08:00:00.000Z', durationMs: 900, during: ['self-check'], stacks: [] };

    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus(
        'fyd',
        runningReport,
        health(),
        liveness({
          status: 'ok',
          eventLoop: { lagMs: 0, maxLagMs: 900, stalls: 1, lastStall: stall, worstStall: stall },
        }),
      ),
      'fy',
    );

    // Assert
    should(actual).containEql('last 0.9s at 2026-10-21T08:00:00.000Z during self-check');
    should(actual).not.containEql('worst stall');
  });

  it('should say plainly when nothing supervises the daemon', () => {
    // Act
    const actual = renderDaemonStatus(decideDaemonStatus('fyd', absentReport, undefined), 'fy');

    // Assert
    should(actual).equal('fyd is stopped\n  not managed by a service manager');
  });

  it('should quote the manager detail when it has something to add', () => {
    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus('fyd', { manager: 'systemd', state: 'failed', detail: 'systemd reports failed' }, undefined),
      'fy',
    );

    // Assert
    should(actual).containEql('systemd: failed (systemd reports failed)');
  });

  it('should not emit empty parentheses for a blank detail', () => {
    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus('fyd', { manager: 'systemd', state: 'stopped', detail: '' }, undefined),
      'fy',
    );

    // Assert
    should(actual).containEql('systemd: stopped');
    should(actual).not.containEql('()');
  });
});

describe('machine status rendering', () => {
  it('should emit a stable shape a script can branch on', () => {
    // Act
    const actual: unknown = JSON.parse(renderDaemonStatusJson(decideDaemonStatus('fyd', runningReport, health())));

    // Assert
    should(actual).have.property('daemon', 'fyd');
    should(actual).have.property('reachability', 'serving');
    should((actual as { supervisor: unknown }).supervisor).deepEqual({
      manager: 'systemd',
      state: 'running',
      pid: 4242,
    });
    should((actual as { health: { pid: number } }).health.pid).equal(4242);
  });

  it('should omit health entirely when the daemon did not answer', () => {
    // Act
    const actual: unknown = JSON.parse(renderDaemonStatusJson(decideDaemonStatus('fyd', stoppedReport, undefined)));

    // Assert
    should(actual).not.have.property('health');
  });

  it('should carry the manager detail through when there is one', () => {
    // Act
    const actual: unknown = JSON.parse(
      renderDaemonStatusJson(
        decideDaemonStatus('fyd', { manager: 'launchd', state: 'failed', detail: 'crash looping' }, undefined),
      ),
    );

    // Assert
    should((actual as { supervisor: { detail: string } }).supervisor.detail).equal('crash looping');
  });

  it('should omit a blank detail rather than emit an empty string', () => {
    // Act
    const actual: unknown = JSON.parse(
      renderDaemonStatusJson(decideDaemonStatus('fyd', { manager: 'direct', state: 'absent', detail: '' }, undefined)),
    );

    // Assert
    should((actual as { supervisor: object }).supervisor).deepEqual({ manager: 'direct', state: 'absent' });
  });
});

describe('status of a launchd job macOS is throttling', () => {
  const throttled = { manager: 'launchd' as const, state: 'running' as const, pid: 4242, processType: null };

  it('should warn, with the remedy, when the plist declares no ProcessType', () => {
    // Act
    const actual = renderDaemonStatus(decideDaemonStatus('fyd', throttled, health()), 'fy');

    // Assert
    should(actual).containEql(
      '  macOS is throttling the daemon — run fy daemon update (its launchd job declares no ProcessType',
    );
  });

  it('should warn about any ProcessType other than Interactive, naming the one it found', () => {
    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus('fyd', { ...throttled, processType: 'Background' }, health()),
      'fy',
    );

    // Assert
    should(actual).containEql(
      'macOS is throttling the daemon — run fy daemon update (its launchd job declares ProcessType Background',
    );
  });

  it('should name the ProcessType on the supervisor line when it is Interactive', () => {
    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus(
        'fyd',
        { ...throttled, processType: 'Interactive', detail: 'launchd reports running' },
        health(),
      ),
      'fy',
    );

    // Assert
    should(actual).containEql('  launchd: running (launchd reports running), ProcessType Interactive');
    should(actual).not.containEql('throttling');
  });

  it('should say nothing about ProcessType when no plist was read, or on systemd', () => {
    // Act
    const launchd = renderDaemonStatus(
      decideDaemonStatus('fyd', { manager: 'launchd', state: 'absent' }, undefined),
      'fy',
    );
    const systemd = renderDaemonStatus(decideDaemonStatus('fyd', runningReport, health()), 'fy');

    // Assert
    should(launchd).not.containEql('ProcessType');
    should(systemd).not.containEql('ProcessType');
  });

  it('should carry the ProcessType and the verdict in the machine status', () => {
    // Act
    const actual = JSON.parse(renderDaemonStatusJson(decideDaemonStatus('fyd', throttled, health()))) as {
      supervisor: Record<string, unknown>;
    };

    // Assert
    should(actual.supervisor).match({ processType: null, throttled: true });
  });
});

describe('install rendering', () => {
  it('should name the file it wrote, so an operator can inspect it', () => {
    // Act
    const actual = renderInstalled('fyd', '/tmp/units/fyd.service', 99);

    // Assert
    should(actual).equal('fyd user service installed from /tmp/units/fyd.service and started (pid 99)');
  });

  it('should omit the pid when none is known', () => {
    // Act
    const actual = renderInstalled('fyd', '/tmp/units/fyd.service', undefined);

    // Assert
    should(actual).equal('fyd user service installed from /tmp/units/fyd.service and started');
  });
});

describe('status of a daemon serving outside its service manager', () => {
  const failedUnit = { manager: 'systemd' as const, state: 'failed' as const, detail: 'systemd reports failed' };

  it('should say it is serving but supervised by nothing, beside what the manager reports', () => {
    // Act
    const actual = renderDaemonStatus(decideDaemonStatus('fyd', failedUnit, health({ pid: 31337 })), 'fy');

    // Assert
    should(actual).startWith('fyd is serving, but OUTSIDE systemd — nothing supervises it\n');
    should(actual).containEql('pid 31337');
    should(actual).endWith('  systemd: failed (systemd reports failed)');
  });

  it('should still be a serving status, so a script asking "can I use it" is not failed', () => {
    // Act
    const actual = decideDaemonStatus('fyd', failedUnit, health({ pid: 31337 }));

    // Assert
    should(actual.orphan).be.true();
    should(statusExitCode(actual)).equal(0);
  });

  it('should carry the verdict in the machine shape, false for a supervised daemon', () => {
    // Act
    const orphan: unknown = JSON.parse(renderDaemonStatusJson(decideDaemonStatus('fyd', failedUnit, health())));
    const supervised: unknown = JSON.parse(renderDaemonStatusJson(decideDaemonStatus('fyd', runningReport, health())));
    const stopped: unknown = JSON.parse(renderDaemonStatusJson(decideDaemonStatus('fyd', stoppedReport, undefined)));

    // Assert
    should(orphan).have.property('orphan', true);
    should(supervised).have.property('orphan', false);
    should(stopped).have.property('orphan', false);
  });
});
