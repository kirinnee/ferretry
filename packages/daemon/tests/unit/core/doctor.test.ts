import { describe, it } from 'bun:test';
import type { DoctorReport } from '@ferretry/protocol';
import should from 'should';
import { readDoctorReport, renderDoctorReport } from '../../../src/lib/core/doctor.ts';
import type { HarnessPreflight } from '../../../src/lib/core/harness-readiness.ts';

const harnesses: HarnessPreflight = {
  ready: true,
  harnesses: [
    {
      kind: 'claude',
      launchable: ['claude-auto-one'],
      blocked: [],
      command: {
        kind: 'claude',
        outcome: 'located',
        path: '/usr/bin/claude',
        rule: 'inherited environment',
        declaredBy: 'PATH',
      },
    },
    { kind: 'codex', launchable: [], blocked: [], command: { kind: 'codex', outcome: 'absent', searched: [] } },
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

  it('should name each harness command, where it is, and which rule found it', () => {
    // Act
    const result = report('linux', ['tmux', 'bash']);
    const claude = result.checks.find(check => check.name === 'claude');
    const codex = result.checks.find(check => check.name === 'codex');

    // Assert — this report's own promise is "programs this daemon host needs, and what each absence
    // breaks", and "found on PATH" answers neither which `claude` nor whether an override took.
    should(claude?.status).equal('present');
    should(claude?.summary).equal('/usr/bin/claude  (inherited environment — PATH)');
    should(codex?.status).equal('missing');
    should(codex?.impact).match(/no codex session can start on this host/u);
    // A host with only Claude installed is a working host, so neither may be `required`.
    should([claude?.requirement, codex?.requirement]).deepEqual(['alternative', 'alternative']);
    should(result.ready).be.true();
  });

  it('should call an override that names nothing a misconfiguration rather than an absence', () => {
    // Arrange: the operator declared a path and it is wrong. Nothing was searched after it.
    const result = readDoctorReport({
      platform: 'linux',
      directorySyscalls: true,
      executables: { resolve: name => (['tmux', 'bash'].includes(name) ? `/bin/${name}` : undefined) },
      harnesses: {
        ...harnesses,
        harnesses: [
          {
            kind: 'claude',
            launchable: ['claude-auto-one'],
            blocked: [],
            command: {
              kind: 'claude',
              outcome: 'override-absent',
              path: '/opt/typo/claude',
              declaredBy: 'FY_CLAUDE_BIN',
              reason: 'FY_CLAUDE_BIN names /opt/typo/claude for claude and this host cannot run that file',
            },
          },
          harnesses.harnesses[1] as (typeof harnesses.harnesses)[number],
        ],
      },
    });

    // Assert — the operator has already done the thing a plain "install it" would tell them to do,
    // so their own declaration leads and the key to fix is named.
    const claude = result.checks.find(check => check.name === 'claude');
    should(claude?.status).equal('missing');
    should(claude?.summary).equal('declared, and unusable');
    should(claude?.impact).match(/^FY_CLAUDE_BIN names \/opt\/typo\/claude/u);
    should(claude?.impact).match(/no claude session can start on this host/u);
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
    // The limit is stated every time, and it now has two halves: nothing here was launched, and
    // resolving a program is not evidence that it is signed in.
    should(renderDoctorReport(noConfinement).join('\n')).match(/nothing here was launched/u);
    should(renderDoctorReport(noConfinement).join('\n')).match(/does not prove a harness is signed in/u);
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
      {
        kind: 'claude',
        launchable: [],
        blocked: [],
        command: {
          kind: 'claude',
          outcome: 'located',
          path: '/usr/bin/claude',
          rule: 'inherited environment',
          declaredBy: 'PATH',
        },
      },
      {
        kind: 'codex',
        launchable: [],
        blocked: [],
        command: {
          kind: 'codex',
          outcome: 'located',
          path: '/usr/bin/codex',
          rule: 'inherited environment',
          declaredBy: 'PATH',
        },
      },
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
