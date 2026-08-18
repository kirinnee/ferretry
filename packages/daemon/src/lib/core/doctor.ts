import type { DoctorCheck, DoctorReport } from '@ferretry/protocol';
import {
  harnessAbsenceImpact,
  type HarnessPreflight,
  type HarnessReadiness,
  harnessLocationLine,
} from './harness-readiness.ts';

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
 * ONE HARNESS COMMAND, BY PATH AND BY RULE — a different fact from the `claude or codex` line above.
 *
 * That line is about the MANIFEST: whether a published wrapper is launchable. This one is about this
 * MACHINE: whether the harness's own command is here at all, which file it is, and which rule chose
 * it. The confusion between them is the one this whole class of check exists to stop shipping —
 * somebody installs Claude Code, is told no harness is ready, and is right to object.
 *
 * THE RULE IS PART OF THE ANSWER. "found on PATH" cannot tell an operator whether the override they
 * wrote is in effect, and a report they cannot act on is the reason this daemon's own detection went
 * unfixed: a service-managed daemon inherits a minimal environment, so the interesting cases are
 * exactly the ones a boolean flattens.
 *
 * `alternative`, NEVER `required`: a host with only Claude installed is a perfectly working host, so
 * a missing Codex must not make this report say a required dependency is absent.
 */
function harnessCommand(harness: HarnessReadiness): DoctorCheck {
  const impact = harnessAbsenceImpact(harness.kind);
  const location = harness.command;
  if (location.outcome === 'located')
    return present(harness.kind, 'alternative', harnessLocationLine(location), impact);
  // An override that names nothing is a MISCONFIGURATION rather than an absence, and its own reason
  // leads: the operator has already done the thing this check would otherwise tell them to do.
  if (location.outcome === 'override-absent')
    return missing(harness.kind, 'alternative', 'declared, and unusable', `${location.reason}. ${impact}`);
  return missing(harness.kind, 'alternative', harnessLocationLine(location), impact);
}

/**
 * The complete dependency inventory, derived from the direct call sites that spawn a child and the
 * generated Claude wrapper. This performs lookups and stats only; it deliberately never claims a
 * harness is signed in or provider-reachable, and it launches nothing to find out. Harness readiness
 * itself comes from the start path's existing rule.
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
    // Every harness, always, including one nothing is published for: "is Codex set up on this host?"
    // is the question being asked, and a report listing only what it found cannot answer it.
    ...input.harnesses.harnesses.map(harnessCommand),
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
      'Resolving a program and stating that this host could run it is all this report proves — nothing here was launched. It does not prove a harness is signed in, has credit, or can reach its provider.',
  };
}

export function renderDoctorReport(report: DoctorReport): readonly string[] {
  const label = (check: DoctorCheck): string => {
    if (check.status === 'present') return 'ok';
    if (check.status === 'not_applicable') return 'n/a';
    return check.requirement === 'optional' ? 'note' : 'missing';
  };
  return [
    ...report.checks.map(check => {
      const detail = check.status === 'missing' ? `${check.summary} — ${check.impact}` : check.summary;
      return `${label(check).padEnd(8)} ${check.name.padEnd(16)} ${detail}`;
    }),
    `note     limitation        ${report.limitation}`,
  ];
}
