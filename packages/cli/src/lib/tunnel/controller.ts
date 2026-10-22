import { FyHttpError, FyTransportError } from '@ferretry/protocol/client';
import type { ITunnelGateway, ITunnelOutput } from './ports.ts';
import { renderTunnelChange, renderTunnelDaemonDown, renderTunnelUnsupported } from './render.ts';

/** Flags the tunnel commands accept. */
export interface TunnelCommandOptions {
  readonly json?: boolean;
}

export interface TunnelControllerDeps {
  readonly gateway: ITunnelGateway;
  readonly out: ITunnelOutput;
  /** The command a human types, so every message names it rather than inventing one. */
  readonly clientName: string;
}

/**
 * Drives `fy daemon tunnel on|off|status`. This command line holds the admin token and calls from the
 * machine itself, so the daemon treats it as ungoverned: no grant, no passkey, no prompt.
 *
 * THE DAEMON APPLIES THE SWITCH, NEVER THIS COMMAND. It writes the entry, starts or stops the carrier
 * and releases the tunnel in one act; a command that edited the file while the daemon was down would
 * leave a decision nothing applied and nothing reported.
 */
export class TunnelController {
  constructor(private readonly deps: TunnelControllerDeps) {}

  async on(): Promise<void> {
    await this.#change(true);
  }

  async off(): Promise<void> {
    await this.#change(false);
  }

  async status(options: TunnelCommandOptions): Promise<void> {
    try {
      const view = await this.deps.gateway.read();
      this.deps.out.success(options.json === true ? JSON.stringify(view) : view.sentence);
    } catch (error) {
      this.#refuse(error, 'status');
    }
  }

  async #change(enabled: boolean): Promise<void> {
    try {
      this.deps.out.success(renderTunnelChange(await this.deps.gateway.change(enabled)));
    } catch (error) {
      this.#refuse(error, enabled ? 'on' : 'off');
    }
  }

  #refuse(error: unknown, verb: string): void {
    if (error instanceof FyTransportError) this.deps.out.error(renderTunnelDaemonDown(this.deps.clientName, verb));
    else if (error instanceof FyHttpError && error.status === 404)
      this.deps.out.error(renderTunnelUnsupported(this.deps.clientName));
    else throw error;
    this.deps.out.setExitCode(1);
  }
}
