import { describe, it } from 'bun:test';
import should from 'should';
import { readDoctorReport } from '../../../src/lib/core/doctor.ts';
import type { HarnessPreflight } from '../../../src/lib/core/harness-readiness.ts';

const harnesses: HarnessPreflight = {
  ready: true,
  harnesses: [
    { kind: 'claude', launchable: ['claude-auto-one'], blocked: [], commandOnPath: true },
    { kind: 'codex', launchable: [], blocked: [], commandOnPath: false },
  ],
};

function report(platform: NodeJS.Platform, installed: readonly string[] = []) {
  return readDoctorReport({
    platform,
    harnesses,
    directorySyscalls: true,
    executables: { resolve: name => (installed.includes(name) ? `/bin/${name}` : undefined) },
  });
}

describe('doctor report', () => {
  it('should keep a macOS host from being warned about Linux-only tools', () => {
    const result = report('darwin', ['tmux', 'bash']);

    should(result.checks.find(check => check.name === 'launchctl')?.status).equal('missing');
    should(result.checks.find(check => check.name === 'systemctl')?.status).equal('not_applicable');
    should(result.checks.some(check => check.status === 'unavailable_by_design')).be.false();
  });

  it('should report the Linux service manager and omit macOS-only launchd', () => {
    const result = report('linux', ['tmux', 'bash']);

    should(result.checks.find(check => check.name === 'launchctl')?.status).equal('not_applicable');
    should(result.checks.find(check => check.name === 'systemctl')?.status).equal('missing');
  });

  it('should fail the report only for a missing required dependency or no launchable harness', () => {
    should(report('linux', ['tmux', 'bash']).ready).be.true();
    should(report('linux', ['tmux']).ready).be.false();
    should(
      readDoctorReport({
        platform: 'linux',
        harnesses: { ...harnesses, ready: false },
        directorySyscalls: true,
        executables: { resolve: name => (name === 'tmux' || name === 'bash' ? `/bin/${name}` : undefined) },
      }).ready,
    ).be.false();
  });
});
