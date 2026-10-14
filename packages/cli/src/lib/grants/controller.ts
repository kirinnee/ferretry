import { DAEMON_CAPABILITIES, type DaemonCapability, type GrantsPatch } from '@ferretry/protocol';
import type { IGrantGateway, IGrantOutput } from './ports.ts';
import { grantDifference, renderGrantChange, renderGrantHistory, renderGrants } from './render.ts';

/** Flags the grant commands accept. */
export interface GrantCommandOptions {
  readonly json?: boolean;
  /** `--use` / `--no-use`; absent means "leave this axis alone". */
  readonly use?: boolean;
  /** `--configure` / `--no-configure`; absent means "leave this axis alone". */
  readonly configure?: boolean;
}

export interface GrantControllerDeps {
  readonly gateway: IGrantGateway;
  readonly out: IGrantOutput;
  /** The command a human types, so every message names it rather than inventing one. */
  readonly clientName: string;
}

/**
 * Drives `fy daemon config …`.
 *
 * ## NON-INTERACTIVE THROUGHOUT
 *
 * Every verb here is a flag away from being scriptable, and NOTHING prompts. This runs under a
 * service manager and inside provisioning scripts, and a prompt that blocked an unattended run would
 * be a defect rather than a nicety. This command line holds the admin token, so it is ungoverned and
 * needs no confirmation for any change.
 */
export class GrantController {
  constructor(private readonly deps: GrantControllerDeps) {}

  /** The report. Named `show` rather than `get` because it reads and prints; nothing changes. */
  async show(options: GrantCommandOptions): Promise<void> {
    const view = await this.deps.gateway.read();
    if (options.json === true) {
      this.deps.out.success(JSON.stringify(view));
      return;
    }
    this.deps.out.success(renderGrants(view, this.deps.clientName));
  }

  /**
   * Who changed what, most recent first.
   *
   * A READ, so it is never gated: the caller who was refused a capability is exactly the caller
   * asking when it was refused, and gating the history behind the decision would put the answer out
   * of reach of the only person with the question.
   */
  async history(options: GrantCommandOptions): Promise<void> {
    const view = await this.deps.gateway.history();
    this.deps.out.success(options.json === true ? JSON.stringify(view) : renderGrantHistory(view));
  }

  /**
   * Changes one capability.
   *
   * A CHANGE THAT NAMES NEITHER AXIS IS REFUSED rather than treated as a no-op. Somebody who typed
   * `fy daemon config set warden` meant something, and answering "done" for a command that did
   * nothing is how a person comes to believe they configured something they did not.
   */
  async set(capability: string, options: GrantCommandOptions): Promise<void> {
    const target = DAEMON_CAPABILITIES.find(candidate => candidate === capability);
    if (target === undefined) {
      this.deps.out.error(
        `${JSON.stringify(capability)} is not a capability this daemon has; expected one of ${DAEMON_CAPABILITIES.join(', ')}`,
      );
      this.deps.out.setExitCode(1);
      return;
    }
    if (options.use === undefined && options.configure === undefined) {
      this.deps.out.error(
        `nothing to change: name at least one axis, as \`--use\`/\`--no-use\` or \`--configure\`/\`--no-configure\``,
      );
      this.deps.out.setExitCode(1);
      return;
    }
    const before = await this.deps.gateway.read();
    const after = await this.deps.gateway.change(patchFor(target, options));
    this.deps.out.success(renderGrantChange(grantDifference(before, after), this.deps.clientName));
  }
}

function patchFor(capability: DaemonCapability, options: GrantCommandOptions): GrantsPatch {
  return {
    [capability]: {
      ...(options.use === undefined ? {} : { use: options.use }),
      ...(options.configure === undefined ? {} : { configure: options.configure }),
    },
  } as GrantsPatch;
}
