import {
  type DoctorCheck,
  type DoctorReport,
  LOOPBACK_FIREWALL_MARKER_PATH,
  type LoopbackFirewallState,
} from '@ferretry/protocol';
import { hasSubscriptionCrash, parseTmuxVersion, type TmuxReleaseReading, type TmuxVersion } from '../tmux/version.ts';
import {
  type HarnessPreflight,
  type HarnessReadiness,
  harnessAbsenceImpact,
  harnessLocationLine,
} from './harness-readiness.ts';
import { type UserSliceReading, userSliceChecks } from './user-slice.ts';

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
  /**
   * The installed tmux and this daemon's running tmux server, as each printed its release. Absent when
   * the composition root did not ask — the row is then left out rather than guessed.
   */
  readonly tmuxRelease?: TmuxReleaseReading;
  /**
   * Whether the loopback firewall fences this account's fixed browser ports. Absent while the ports are random
   * (nothing to fence) — the row is then left out. Never makes the report not ready.
   */
  readonly loopbackFirewall?: LoopbackFirewallState;
  /**
   * This user's systemd slice limits and linger, read only on a host that looks shared. Absent on a
   * single-user host and wherever there is no systemd to ask — the rows are then left out. Never makes
   * the report not ready.
   */
  readonly userSlice?: UserSliceReading;
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

/**
 * One program, and WHERE it is.
 *
 * The resolved absolute path is reported rather than a bare "found". This report's own promise is
 * "programs this daemon host needs, and what each absence breaks", and a person acting on it needs to
 * know which `claude` was found: a shell alias, a version manager shim and a stale copy in
 * `/usr/local/bin` all say "found on PATH" and are three different programs. The path was already
 * being computed and thrown away for a boolean.
 */
function binary(
  input: DoctorReportInput,
  name: string,
  requirement: DoctorCheck['requirement'],
  impact: string,
): DoctorCheck {
  const resolved = input.executables.resolve(name);
  return resolved === undefined
    ? missing(name, requirement, 'not found on PATH', impact)
    : present(name, requirement, `found on PATH at ${resolved}`, impact);
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

/** A warning, never a gate: a browser still starts without the firewall, so `ready` ignores this row. */
function loopbackFirewall(state: LoopbackFirewallState | undefined): readonly DoctorCheck[] {
  if (state === undefined) return [];
  const name = 'loopback firewall';
  if (state.state === 'applied')
    return [
      present(name, 'capability', 'applied', 'Other users on this host cannot reach this account’s browser ports.'),
    ];
  const summaries: Record<Exclude<LoopbackFirewallState['state'], 'applied'>, string> = {
    failed: 'the last check reached this account’s ports from another user',
    missing: `no firewall rule for this account in the marker at ${LOOPBACK_FIREWALL_MARKER_PATH}`,
    stale: 'the marker does not list this account’s ports',
    unverified: 'the 5-minute firewall check is not running',
  };
  return [missing(name, 'capability', summaries[state.state], state.detail)];
}

const TMUX_CRASH =
  'tmux before 3.7 can crash its whole server — ending every session at once — when a session ends while Ferretry is watching it. Ferretry works around it, but only a newer tmux removes it.';

/** How to move without ending anything: the running server keeps its binary until it next starts. */
const TMUX_MOVE =
  'Do not kill the tmux server to switch: the new release is used the next time the server starts — once the last session has ended, or the machine restarts.';

/**
 * WHICH TMUX, AND WHETHER IT HAS THE SUBSCRIPTION CRASH (`lib/tmux/version.ts`).
 *
 * The RUNNING server is judged as well as the installed program, because they differ after an
 * upgrade: a server keeps the binary it was started from, and the server is what crashes. So a host
 * that installed 3.7 is still told the truth while its 3.6a server is up — and told that nothing has
 * to be stopped for the new release to take over.
 *
 * `capability`, never `required`: tmux 3.6a starts and manages sessions, and this report's
 * `ready` must not say otherwise.
 */
function tmuxRelease(reading: TmuxReleaseReading | undefined): readonly DoctorCheck[] {
  const read = (text: string | undefined): TmuxVersion | undefined =>
    text === undefined ? undefined : parseTmuxVersion(text);
  const program = read(reading?.program);
  const server = read(reading?.server);
  if (program === undefined && server === undefined) return [];
  const parts = [
    ...(program === undefined ? [] : [`installed ${program.label}`]),
    ...(server === undefined ? [] : [`running server ${server.label}`]),
  ];
  const summary = parts.join(', ');
  const programCrashes = program !== undefined && hasSubscriptionCrash(program);
  const serverCrashes = server !== undefined && hasSubscriptionCrash(server);
  if (!programCrashes && !serverCrashes)
    return [present('tmux release', 'capability', summary, 'tmux 3.7 or newer: no known whole-server crash.')];
  if (!programCrashes)
    return [
      missing(
        'tmux release',
        'capability',
        `${summary} — the server still runs the old release`,
        `${TMUX_CRASH} ${program === undefined ? '' : `${program.label} is installed already. `}${TMUX_MOVE}`,
      ),
    ];
  return [
    missing(
      'tmux release',
      'capability',
      `${summary} — 3.7 or newer is needed`,
      `${TMUX_CRASH} Install tmux 3.7 or newer. ${TMUX_MOVE}`,
    ),
  ];
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
    //
    // This states, generally, the fact this branch previously stated with a hardcoded `claude` and
    // `codex` pair: whether the harness's own command is on this MACHINE, as opposed to whether the
    // MANIFEST publishes a launchable wrapper for it. Keeping both spellings would have emitted two
    // rows per harness, so the general one is the one that survives.
    ...input.harnesses.harnesses.map(harnessCommand),
    binary(input, 'tmux', 'required', 'Sessions cannot start or be managed.'),
    ...tmuxRelease(input.tmuxRelease),
    ...loopbackFirewall(input.loopbackFirewall),
    ...userSliceChecks(input.userSlice),
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
    // Found is all this says: the board's watcher runs it with the host's own sign-in, and reports a
    // signed-out `gh` in the daemon log the first time it meets one.
    binary(
      input,
      'gh',
      'optional',
      "The board's GitHub watcher cannot read PR state, link PRs or find releases; cards keep their PR state unknown.",
    ),
  ];
  return {
    checks,
    harnesses,
    ready:
      checks.every(check => check.requirement !== 'required' || check.status !== 'missing') && input.harnesses.ready,
    limitation:
      "Resolving a program and stating that this host could run it is all this report proves — nothing here was launched but `tmux -V` and one version question to this daemon's own tmux server. It does not prove a harness is signed in, has credit, or can reach its provider.",
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
