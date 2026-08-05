import { describe, it } from 'bun:test';
import type { DoctorReport } from '@ferretry/protocol';
import should from 'should';
import { readDoctorReport, renderDoctorReport } from '../../../src/lib/core/doctor.ts';
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

  it('should exercise every platform verdict and state the PATH limitation in the rendered report', () => {
    const installed = ['tmux', 'bash', 'git', 'launchctl', 'cat', 'tail', 'ps', 'nix-store', 'jq'];
    const darwin = report('darwin', installed);
    const linux = report('linux', [...installed, 'systemctl']);
    const noConfinement = readDoctorReport({
      platform: 'linux',
      harnesses,
      directorySyscalls: false,
      executables: { resolve: () => undefined },
    });

    should(darwin.checks.find(check => check.name === 'launchctl')?.status).equal('present');
    should(linux.checks.find(check => check.name === 'systemctl')?.status).equal('present');
    should(linux.checks.find(check => check.name === 'launchctl')?.status).equal('not_applicable');
    should(noConfinement.checks.find(check => check.name === 'directory syscalls')?.status).equal('missing');
    should(renderDoctorReport(noConfinement).join('\n')).match(/PATH presence is all this report proves/u);
    should(renderDoctorReport(noConfinement).join('\n')).match(/note\s+jq/u);
  });
});

describe('doctor report rendering', () => {
  it('should explain impact only for dependencies that are actually missing', () => {
    const subject: DoctorReport = {
      checks: [
        {
          name: 'tmux',
          requirement: 'required',
          status: 'present',
          summary: 'found on PATH',
          impact: 'Sessions cannot start or be managed.',
        },
        {
          name: 'bash',
          requirement: 'required',
          status: 'missing',
          summary: 'not found on PATH',
          impact: 'Generated fleet wrappers cannot run.',
        },
        {
          name: 'jq',
          requirement: 'optional',
          status: 'missing',
          summary: 'not found on PATH',
          impact: 'Generated Claude wrappers skip their first-run JSON seeding step.',
        },
        {
          name: 'launchctl',
          requirement: 'capability',
          status: 'not_applicable',
          summary: 'not used on this operating system',
          impact: 'This service manager is not used on this operating system.',
        },
      ],
      harnesses: [],
      ready: false,
      limitation: 'PATH presence is all this report proves.',
    };

    should(renderDoctorReport(subject)).deepEqual([
      'ok       tmux             found on PATH',
      'missing  bash             not found on PATH — Generated fleet wrappers cannot run.',
      'note     jq               not found on PATH — Generated Claude wrappers skip their first-run JSON seeding step.',
      'n/a      launchctl        not used on this operating system',
      'note     limitation        PATH presence is all this report proves.',
    ]);
    should(subject.checks.map(check => check.impact)).deepEqual([
      'Sessions cannot start or be managed.',
      'Generated fleet wrappers cannot run.',
      'Generated Claude wrappers skip their first-run JSON seeding step.',
      'This service manager is not used on this operating system.',
    ]);
  });
});

describe('doctor report over a manifest the daemon could not read', () => {
  const refusal = 'the fleet manifest at /state/fleet/manifest.json is present but cannot be read: bad shape.';
  const unreadable: HarnessPreflight = {
    ready: false,
    manifestRefusal: refusal,
    harnesses: [
      { kind: 'claude', launchable: [], blocked: [], commandOnPath: true },
      { kind: 'codex', launchable: [], blocked: [], commandOnPath: true },
    ],
  };

  it('should name the unreadable manifest first, and stop the harness line overclaiming', () => {
    // Act
    const result = readDoctorReport({
      platform: 'linux',
      harnesses: unreadable,
      directorySyscalls: true,
      executables: { resolve: () => undefined },
    });

    // Assert — every harness line below is empty for one reason, and a reader who is not told the
    // manifest would not parse reads those blanks as "nothing is published".
    should(result.checks[0]?.name).equal('fleet manifest');
    should(result.checks[0]?.status).equal('missing');
    should(result.checks[0]?.impact).containEql(refusal);
    should(result.checks[1]?.summary).equal(
      'no wrapper could be resolved, because the fleet manifest could not be read',
    );
    should(result.ready).be.false();
  });

  it('should not invent a manifest check when the manifest read fine', () => {
    // Act
    const result = readDoctorReport({
      platform: 'linux',
      harnesses,
      directorySyscalls: true,
      executables: { resolve: () => undefined },
    });

    // Assert
    should(result.checks.some(check => check.name === 'fleet manifest')).be.false();
  });
});
