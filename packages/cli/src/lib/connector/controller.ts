import { FyHttpError, FyTransportError } from '@ferretry/protocol/client';
import type { IConnectorGateway, IConnectorOutput } from './ports.ts';
import { renderApproved, renderDenied, renderRevoked, renderStatus, renderUnreachable } from './render.ts';

/** Flags every connector command accepts. */
export interface ConnectorCommandOptions {
  readonly json?: boolean;
}

export interface ConnectorControllerDeps {
  readonly gateway: IConnectorGateway;
  readonly out: IConnectorOutput;
  /** Milliseconds since the epoch, for "expires in 9 min". */
  readonly now: () => number;
  /** The command a human types, so every message names it rather than inventing one. */
  readonly clientName: string;
}

/**
 * Drives `fy connector …`.
 *
 * This command line holds the host's admin token, so it is the owner at the machine: approving needs no passkey
 * here (docs/mcp-connector.md) and asks no confirmation — the match code the owner types IS the confirmation, and
 * it must match the page they opened from Claude. Every ending is one plain sentence; every refusal exits 1.
 * Refusals are read from the daemon's status and code and printed in its own words; anything unrecognised is
 * rethrown for the composition root.
 */
export class ConnectorController {
  constructor(private readonly deps: ConnectorControllerDeps) {}

  async status(options: ConnectorCommandOptions): Promise<void> {
    await this.#run(async () => {
      const status = await this.deps.gateway.status();
      this.deps.out.success(
        options.json === true ? JSON.stringify(status) : renderStatus(status, this.deps.clientName, this.deps.now()),
      );
    });
  }

  async approve(idOrMatchCode: string, options: ConnectorCommandOptions): Promise<void> {
    await this.#run(async () => {
      const grant = await this.deps.gateway.approve(idOrMatchCode);
      this.deps.out.success(
        options.json === true ? JSON.stringify(grant) : renderApproved(grant, this.deps.clientName),
      );
    });
  }

  async deny(idOrMatchCode: string, options: ConnectorCommandOptions): Promise<void> {
    await this.#run(async () => {
      const pending = await this.deps.gateway.deny(idOrMatchCode);
      this.deps.out.success(options.json === true ? JSON.stringify(pending) : renderDenied(pending));
    });
  }

  async revoke(grantId: string, options: ConnectorCommandOptions): Promise<void> {
    await this.#run(async () => {
      const grant = await this.deps.gateway.revoke(grantId);
      this.deps.out.success(options.json === true ? JSON.stringify(grant) : renderRevoked(grant));
    });
  }

  async #run(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (error instanceof FyTransportError) return this.#fail(renderUnreachable(this.deps.clientName));
      // 404, 409, 410: the daemon's own sentence says what happened and what to do (not found, expired, already
      // decided, connector off). A 403 is a refusal of the caller and reads the same way.
      if (error instanceof FyHttpError && [403, 404, 409, 410].includes(error.status)) return this.#fail(error.message);
      throw error;
    }
  }

  #fail(message: string): void {
    this.deps.out.error(message);
    this.deps.out.setExitCode(1);
  }
}
