import {
  type IFyApiClient,
  type SessionCredentialRevoked,
  type SessionStatus,
  SessionCredentialRevokedSchema,
} from '@ferretry/protocol';
import type { Command } from 'commander';
import { SessionCommandError } from './errors.ts';
import type { SessionPresenter } from './presenter.ts';

/** Statuses with no pane to keep running. */
const PANELESS: ReadonlySet<SessionStatus> = new Set(['created', 'completed', 'failed', 'stopped']);

/** The one route `fy session revoke-credential` speaks. */
export interface ISessionCredentialGateway {
  revoke(session: string): Promise<SessionCredentialRevoked>;
}

/** Speaks it through the protocol client; the answer is parsed against the protocol's own schema. */
export class ProtocolSessionCredentialGateway implements ISessionCredentialGateway {
  constructor(private readonly client: Pick<IFyApiClient, 'request'>) {}

  async revoke(session: string): Promise<SessionCredentialRevoked> {
    return await this.client.request(
      `/v1/sessions/${encodeURIComponent(session)}/revoke-credential`,
      SessionCredentialRevokedSchema,
      { method: 'POST' },
    );
  }
}

/**
 * Cuts one ferret off: `fy session revoke-credential <session>` (docs/agent-tools.md § "Cutting a ferret off").
 *
 * The session's credential is revoked at once, so a pane whose `fy`, MCP server and agent tools present it
 * (`fys_…`) is refused from now on, and no launch gives it one again until a person resumes it. The reply says
 * plainly what it does NOT reach: a pane still on the admin token (an older `fy`, or one that read
 * `api-token`), which only a stop cuts off. The session may be named by id or first name;
 * the daemon reads the name, as for every per-session route. Only a person may do this: the daemon refuses a
 * ferret's own credential before it reads anything.
 */
export class RevokeCredentialController {
  constructor(
    private readonly gateway: ISessionCredentialGateway,
    private readonly presenter: SessionPresenter,
    private readonly binaryName: string,
  ) {}

  async execute(reference: string, flags: { readonly json?: boolean } = {}): Promise<void> {
    const session = reference.trim();
    if (session === '') throw new SessionCommandError('name the session whose credential to revoke');
    const revoked = await this.gateway.revoke(session);
    if (flags.json === true) {
      this.presenter.json(revoked);
      return;
    }
    const id = revoked.sessionId;
    this.presenter.lines([
      `revoked ${id}'s credential: where its ${this.binaryName}, MCP server and tools present their own (fys_…), they are refused from now on`,
      `no restart, revive or migration gives it a credential again until a person resumes it: ${this.binaryName} resume ${id}`,
      PANELESS.has(revoked.status)
        ? `it is ${revoked.status}`
        : `it keeps running; a pane still on the admin token (an older ${this.binaryName}, or one that read api-token) is not cut off by this — to stop it too: ${this.binaryName} stop ${id}`,
    ]);
  }
}

/** `fy session revoke-credential <session> [--json]`. Wiring only; the controller decides. */
export function registerSessionCredentialCommands(
  program: Command,
  controller: RevokeCredentialController,
  presenter: SessionPresenter,
): void {
  const session = program.command('session').description("act on a session's own standing with this daemon");
  session
    .command('revoke-credential')
    .description('cut a ferret off at once: its own credential stops working until a person resumes it')
    .argument('<session>', 'session id or first name')
    .option('--json', 'print the answer as JSON')
    .action(async (reference: string, options: { readonly json?: boolean }) => {
      try {
        await controller.execute(reference, options.json === true ? { json: true } : {});
      } catch (error) {
        presenter.fail(error);
      }
    });
}
