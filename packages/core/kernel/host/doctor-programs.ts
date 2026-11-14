import type { DoctorFinding } from '../contract/kernel.ts';
import type { DoctorLine } from './host.ts';

/**
 * THE HOST'S PROGRAM INVENTORY (today's `daemon/src/lib/core/doctor.ts`, the `binary(...)` rows): the programs this
 * daemon host leans on that no plugin owns, each with where it was found and what its absence breaks. A lookup only:
 * nothing is launched to find out (`kernel.paths.which`). The words are today's.
 *
 * `required` is the one kind that fails the report; `capability` and `optional` are warnings that name the loss. The
 * service manager of the OTHER operating system is a `not applicable` row, never a warning.
 */
export interface ProgramFacts {
  /** `kernel.paths.which`: the path a bare name resolves to on this daemon's `PATH`, or nothing. */
  readonly which: (name: string) => Promise<string | undefined>;
  /** `process.platform`, handed in so this module reads no global. */
  readonly platform: string;
  /** The client binary's name (`fy`), for the sentences that name a command. */
  readonly binary: string;
}

type Requirement = NonNullable<DoctorFinding['requirement']>;

async function program(
  facts: ProgramFacts,
  name: string,
  requirement: Requirement,
  impact: string,
): Promise<DoctorLine> {
  const found = await facts.which(name);
  const base = { plugin: 'kernel', name, requirement, fix: impact } as const;
  if (found !== undefined) return { ...base, state: 'ok', detail: `found on PATH at ${found}` };
  return { ...base, state: requirement === 'required' ? 'fail' : 'warn', detail: 'not found on PATH' };
}

const notUsed = (name: string): DoctorLine => ({
  plugin: 'kernel',
  name,
  requirement: 'capability',
  state: 'ok',
  notApplicable: true,
  detail: 'not used on this operating system',
  fix: 'This service manager is not used on this operating system.',
});

export async function hostProgramLines(facts: ProgramFacts): Promise<readonly DoctorLine[]> {
  const { binary } = facts;
  return [
    await program(facts, 'bash', 'required', 'Generated fleet wrappers cannot run.'),
    await program(
      facts,
      'git',
      'capability',
      'Worktrees, project inspection, and repository features are unavailable.',
    ),
    facts.platform === 'darwin'
      ? await program(
          facts,
          'launchctl',
          'capability',
          `\`${binary} daemon install\` cannot install or manage its launchd service.`,
        )
      : notUsed('launchctl'),
    facts.platform === 'linux'
      ? await program(
          facts,
          'systemctl',
          'capability',
          `\`${binary} daemon install\` cannot install or manage its systemd user service.`,
        )
      : notUsed('systemctl'),
    await program(
      facts,
      'cat',
      'capability',
      `\`${binary} daemon logs\` cannot print the current log without following it.`,
    ),
    await program(facts, 'tail', 'capability', `\`${binary} daemon logs --follow\` cannot stream the daemon log.`),
    await program(
      facts,
      'ps',
      'capability',
      'A session move cannot inspect a pane’s process tree, so it cannot tell what is still running there.',
    ),
    await program(
      facts,
      'nix-store',
      'optional',
      'The daemon cannot hold a Nix garbage-collection root; it continues without one.',
    ),
    await program(
      facts,
      'jq',
      'optional',
      'Generated Claude wrappers skip their first-run JSON seeding step; they continue with a warning.',
    ),
    // Found is all this says: the board's watcher runs it with the host's own sign-in.
    await program(
      facts,
      'gh',
      'optional',
      "The board's GitHub watcher cannot read PR state, link PRs or find releases; cards keep their PR state unknown.",
    ),
  ];
}
