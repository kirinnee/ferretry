import type { IDaemonOutput } from './ports.ts';

interface MachineSetupNoticeDeps {
  /** Whether the daemon that just started has a runtime to launch. Throws when it cannot say. */
  readonly setUp: () => Promise<boolean>;
  readonly out: IDaemonOutput;
  /** Whether a PERSON is watching this invocation, asked when the line would be said. */
  readonly interactive: () => boolean;
  /** What a person types to run this binary, so the line names commands they have. */
  readonly clientName: string;
}

/**
 * The ONE line a `daemon start` at a terminal ends with when this machine is not set up yet.
 *
 * Starting a daemon never imports anything: a fresh machine stays "not set up" until somebody chooses,
 * in the app or with `daemon setup`. So the person who just started it is told both ways in, once.
 *
 * QUIET UNLESS IT IS TRUE AND SOMEBODY IS THERE. No terminal, a machine that is set up, or a daemon that
 * could not say all print nothing: this is a pointer, never a verdict, and a start that worked must
 * never read as one that did not.
 */
export class MachineSetupNotice {
  constructor(private readonly deps: MachineSetupNoticeDeps) {}

  async say(): Promise<void> {
    if (!this.deps.interactive()) return;
    let setUp: boolean;
    try {
      setUp = await this.deps.setUp();
    } catch {
      return;
    }
    if (setUp) return;
    const bin = this.deps.clientName;
    this.deps.out.warn(
      `This machine isn't set up yet. Pair a phone (\`${bin} pair\`) and finish in the app, or run \`${bin} daemon setup\`.`,
    );
  }
}
