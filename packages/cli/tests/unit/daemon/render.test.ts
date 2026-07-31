import { describe, it } from 'bun:test';
import should from 'should';
import {
  decideDaemonStatus,
  renderDaemonStatus,
  renderDaemonStatusJson,
  renderInstalled,
  statusExitCode,
} from '../../../src/lib/daemon/render';
import { absentReport, health, runningReport, stoppedReport } from './fixtures';

describe('status decision', () => {
  it('should call the daemon serving whenever its API answered', () => {
    // Act
    const actual = decideDaemonStatus('fyd', absentReport, health());

    // Assert — the HTTP API is ground truth; a unit-only check false-negatives a hand-started daemon.
    should(actual.reachability).equal('serving');
    should(actual.health?.pid).equal(4242);
  });

  it('should call a supervised-but-silent daemon unreachable', () => {
    // Act
    const actual = decideDaemonStatus('fyd', runningReport, undefined);

    // Assert
    should(actual.reachability).equal('unreachable');
    should(actual.health).be.undefined();
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
  });
});

describe('human status rendering', () => {
  it('should lead with the verdict and summarise the health the daemon reported', () => {
    // Act
    const actual = renderDaemonStatus(decideDaemonStatus('fyd', runningReport, health()));

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
    );

    // Assert
    should(actual).containEql('bootstrap degraded (degraded)');
  });

  it('should say a process exists when the API does not answer', () => {
    // Act
    const actual = renderDaemonStatus(decideDaemonStatus('fyd', runningReport, undefined));

    // Assert
    should(actual).startWith('fyd process exists (pid 4242) but its API is unavailable');
  });

  it('should omit the pid when the supervisor did not report one', () => {
    // Act
    const actual = renderDaemonStatus(decideDaemonStatus('fyd', { manager: 'launchd', state: 'running' }, undefined));

    // Assert
    should(actual).startWith('fyd process exists but its API is unavailable');
  });

  it('should say plainly when nothing supervises the daemon', () => {
    // Act
    const actual = renderDaemonStatus(decideDaemonStatus('fyd', absentReport, undefined));

    // Assert
    should(actual).equal('fyd is stopped\n  not managed by a service manager');
  });

  it('should quote the manager detail when it has something to add', () => {
    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus('fyd', { manager: 'systemd', state: 'failed', detail: 'systemd reports failed' }, undefined),
    );

    // Assert
    should(actual).containEql('systemd: failed (systemd reports failed)');
  });

  it('should not emit empty parentheses for a blank detail', () => {
    // Act
    const actual = renderDaemonStatus(
      decideDaemonStatus('fyd', { manager: 'systemd', state: 'stopped', detail: '' }, undefined),
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
