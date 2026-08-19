import { DAEMON_CAPABILITIES, type DaemonCapability, type GrantsPatch } from '@ferretry/protocol';
import type { IGrantGateway, IGrantOutput, IOperatorPasswordSource } from './ports.ts';
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
  readonly passwords: IOperatorPasswordSource;
  readonly out: IGrantOutput;
  /** The command a human types, so every message names it rather than inventing one. */
  readonly clientName: string;
}

/**
 * Drives `fy daemon config …` and `fy daemon password …`.
 *
 * ## NON-INTERACTIVE THROUGHOUT
 *
 * Every verb here is a flag away from being scriptable, and NOTHING prompts. This runs under a
 * service manager and inside provisioning scripts, and a prompt that blocked an unattended run would
 * be a defect rather than a nicety. The one value that cannot be a flag is the password, and it comes
 * in on stdin — which is scriptable too, and is the only form that keeps it out of shell history.
 *
 * ## THE UNLOCK IS EARNED PER COMMAND AND NEVER STORED
 *
 * A change that needs the operator password reads it from stdin, trades it for a short-lived unlock,
 * spends that unlock on one request and forgets both. Nothing is written to disk, and no field on
 * this class outlives the call.
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
   * A READ, so it takes no unlock and no password: the caller who was refused a capability is exactly
   * the caller asking when it was refused, and gating the history behind the decision would put the
   * answer out of reach of the only person with the question.
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
   *
   * The operator password is read ONLY when the change actually widens something and the machine has
   * one. Revoking never asks for it — in an incident the fastest possible path to "the UI can no
   * longer do that" matters more than the confirmation.
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
    const patch = patchFor(target, options);
    const unlock = (await this.widens(target, options, before.passwordSet))
      ? await this.deps.gateway.unlock(await this.deps.passwords.read())
      : undefined;
    const after = await this.deps.gateway.change(patch, unlock);
    this.deps.out.success(renderGrantChange(grantDifference(before, after), this.deps.clientName));
  }

  /**
   * Sets the operator password, turning the security layer on for this machine.
   *
   * The VALUE comes from stdin and is never echoed, never logged and never rendered back. What the
   * daemon stores is an argon2id verifier; nothing on either side can recover the password from it,
   * which is why there is no command to show one.
   *
   * IT IS ALSO THE ONLY WAY BACK. There is no companion verb that removes the password — removing one
   * left every already-paired device on an ungated machine — so this replaces without ever asking for
   * the old one, and a forgotten password is repaired here rather than being a lockout.
   */
  async setPassword(): Promise<void> {
    await this.deps.gateway.setPassword(await this.deps.passwords.read());
    this.deps.out.success('operator password set — changing any grant from off this host now needs it');
  }

  /** Whether this change turns anything ON, which is the only case that needs the password. */
  private async widens(
    capability: DaemonCapability,
    options: GrantCommandOptions,
    passwordSet: boolean,
  ): Promise<boolean> {
    if (!passwordSet) return false;
    const current = (await this.deps.gateway.read()).capabilities.find(entry => entry.capability === capability);
    if (current === undefined) return true;
    return (options.use === true && !current.granted.use) || (options.configure === true && !current.granted.configure);
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
