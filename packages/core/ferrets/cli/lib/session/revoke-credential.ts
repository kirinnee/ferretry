import { SessionCommandError } from './errors.ts';
import type { SessionPresenter } from './presenter.ts';

/** What `POST /v1/ferrets/:ferretId/revoke-credential` answers: whether a token was live, never a token. */
export interface CredentialRevoked {
  readonly id: string;
  readonly revoked: boolean;
}

/** The route `fy session revoke-credential` speaks, and the ferret's state after it. */
export interface ISessionCredentialGateway {
  revoke(session: string): Promise<CredentialRevoked>;
  /** The ferret's state now (`stopped` has no pane to keep running). */
  state(session: string): Promise<string>;
}

/**
 * Cuts one ferret off: `fy session revoke-credential <ferret>`.
 *
 * The ferret's token is revoked at once, so a pane whose `fy`, MCP server and agent tools present it (`fys_…`) is
 * refused from now on, and no launch gives it one again until a person resumes it. The reply says plainly what it
 * does NOT reach: a pane still on the admin token, which only a stop cuts off. Only a person may do this: the route is
 * person-only, and the shell refuses it from a ferret's pane before anything is sent.
 */
export class RevokeCredentialController {
  constructor(
    private readonly gateway: ISessionCredentialGateway,
    private readonly presenter: SessionPresenter,
    private readonly binaryName: string,
  ) {}

  async execute(reference: string, flags: { readonly json?: boolean } = {}): Promise<void> {
    const session = reference.trim();
    if (session === '') throw new SessionCommandError('name the ferret whose credential to revoke');
    const revoked = await this.gateway.revoke(session);
    if (flags.json === true) {
      this.presenter.json(revoked);
      return;
    }
    const id = revoked.id;
    const state = await this.gateway.state(id);
    this.presenter.lines([
      revoked.revoked
        ? `revoked ${id}'s credential: where its ${this.binaryName}, MCP server and tools present their own (fys_…), they are refused from now on`
        : `${id} held no live credential; none is issued to it from now on`,
      `no restart or resume gives it a credential again until a person resumes it: ${this.binaryName} resume ${id}`,
      state === 'stopped'
        ? `it is ${state}`
        : `it keeps running; a pane still on the admin token is not cut off by this — to stop it too: ${this.binaryName} stop orphan ${id}`,
    ]);
  }
}
