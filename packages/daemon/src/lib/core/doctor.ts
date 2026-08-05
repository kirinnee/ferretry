import type { DoctorCheck, DoctorReport } from '@ferretry/protocol';
import type { HarnessPreflight } from './harness-readiness.ts';

export interface DoctorExecutableResolver {
  resolve(name: string): string | undefined;
}

export interface DoctorReportInput {
  /** Injected once by the composition root; this pure module never reads global runtime state. */
  readonly platform: NodeJS.Platform;
  readonly executables: DoctorExecutableResolver;
  readonly harnesses: HarnessPreflight;
  /** A real FFI load result, not an assumption based on the operating system. */
  readonly directorySyscalls: boolean;
}

const present = (
  name: string,
  requirement: DoctorCheck['requirement'],
  summary: string,
  impact: string,
): DoctorCheck => ({
  name,
  requirement,
  status: 'present',
  summary,
  impact,
});

const missing = (
  name: string,
  requirement: DoctorCheck['requirement'],
  summary: string,
  impact: string,
): DoctorCheck => ({
  name,
  requirement,
  status: 'missing',
  summary,
  impact,
});

const unavailable = (name: string, summary: string): DoctorCheck => ({
  name,
  requirement: 'capability',
  status: 'not_applicable',
  summary,
  impact: 'This service manager is not used on this operating system.',
});

function binary(
  input: DoctorReportInput,
  name: string,
  requirement: DoctorCheck['requirement'],
  impact: string,
): DoctorCheck {
  return input.executables.resolve(name) === undefined
    ? missing(name, requirement, 'not found on PATH', impact)
    : present(name, requirement, 'found on PATH', impact);
}

/**
 * The complete dependency inventory, derived from the direct process call sites and generated
 * Claude wrapper. This performs PATH checks only; it deliberately never claims a harness is signed
 * in or provider-reachable. Harness readiness itself comes from the start path's existing rule.
 */
export function readDoctorReport(input: DoctorReportInput): DoctorReport {
  const harnesses = input.harnesses.harnesses.map(({ kind, launchable, blocked }) => ({
    kind,
    launchable: [...launchable],
    blocked: [...blocked],
  }));
  const checks: DoctorCheck[] = [
    // FIRST, when it applies. Every harness line below it is empty for the same reason, and a reader
    // who is not told that the manifest would not parse reads those blanks as "nothing is published".
    ...(input.harnesses.manifestRefusal === undefined
      ? []
      : [
          missing(
            'fleet manifest',
            'required',
            'published, but this daemon could not read it',
            `${input.harnesses.manifestRefusal} Until then this report can say nothing about which accounts exist.`,
          ),
        ]),
    input.harnesses.ready
      ? present(
          'claude or codex',
          'alternative',
          'at least one published wrapper is launchable',
          'Sessions can use the preferred ready harness (Claude when both are ready).',
        )
      : input.harnesses.manifestRefusal === undefined
        ? missing(
            'claude or codex',
            'alternative',
            'no published Claude or Codex wrapper is launchable',
            'No agent session can start. Install a harness, publish an account wrapper, and apply the fleet.',
          )
        : // The weaker, true sentence: nothing was found because nothing could be read.
          missing(
            'claude or codex',
            'alternative',
            'no wrapper could be resolved, because the fleet manifest could not be read',
            'No agent session can start. Repair the fleet manifest reported above; this line is not evidence about any account.',
          ),
    binary(input, 'tmux', 'required', 'Sessions cannot start or be managed.'),
    binary(input, 'bash', 'required', 'Generated fleet wrappers cannot run.'),
    binary(input, 'git', 'capability', 'Worktrees, project inspection, and repository features are unavailable.'),
    input.platform === 'darwin'
      ? binary(input, 'launchctl', 'capability', '`fy daemon install` cannot install or manage its launchd service.')
      : unavailable('launchctl', 'not used on this operating system'),
    input.platform === 'linux'
      ? binary(
          input,
          'systemctl',
          'capability',
          '`fy daemon install` cannot install or manage its systemd user service.',
        )
      : unavailable('systemctl', 'not used on this operating system'),
    binary(input, 'cat', 'capability', '`fy daemon logs` cannot print the current log without following it.'),
    binary(input, 'tail', 'capability', '`fy daemon logs --follow` cannot stream the daemon log.'),
    binary(input, 'ps', 'capability', 'Migration preflight cannot inspect a session pane process tree.'),
    input.directorySyscalls
      ? present(
          'directory syscalls',
          'capability',
          'the platform C library loaded',
          'Session filesystem confinement can use kernel-backed directory operations.',
        )
      : missing(
          'directory syscalls',
          'capability',
          'the platform C library could not be loaded',
          'Session filesystem confinement is unavailable; Ferretry refuses rather than browsing an unconfined path.',
        ),
    binary(
      input,
      'nix-store',
      'optional',
      'The daemon cannot hold a Nix garbage-collection root; it continues without one.',
    ),
    binary(
      input,
      'jq',
      'optional',
      'Generated Claude wrappers skip their first-run JSON seeding step; they continue with a warning.',
    ),
  ];
  return {
    checks,
    harnesses,
    ready:
      checks.every(check => check.requirement !== 'required' || check.status !== 'missing') && input.harnesses.ready,
    limitation:
      'PATH presence is all this report proves. It does not prove a harness is signed in, has credit, or can reach its provider.',
  };
}

export function renderDoctorReport(report: DoctorReport): readonly string[] {
  const label = (check: DoctorCheck): string => {
    if (check.status === 'present') return 'ok';
    if (check.status === 'not_applicable') return 'n/a';
    return check.requirement === 'optional' ? 'note' : 'missing';
  };
  return [
    ...report.checks.map(
      check => `${label(check).padEnd(8)} ${check.name.padEnd(16)} ${check.summary} — ${check.impact}`,
    ),
    `note     limitation        ${report.limitation}`,
  ];
}
