import { type IFyApiClient, type SessionView } from '@ferretry/protocol';
import type { Command } from 'commander';
import { SessionCommandError } from './errors.ts';
import type { SessionPresenter } from './presenter.ts';

/** The two routes `fy session pin` and `fy session unpin` speak. */
export interface ISessionPinGateway {
  pin(session: string): Promise<SessionView>;
  unpin(session: string): Promise<SessionView>;
}

/** Speaks them through the protocol client; the answer is already parsed against the protocol's own schema. */
export class ProtocolSessionPinGateway implements ISessionPinGateway {
  constructor(private readonly client: Pick<IFyApiClient, 'pinSession' | 'unpinSession'>) {}

  async pin(session: string): Promise<SessionView> {
    return await this.client.pinSession(session);
  }

  async unpin(session: string): Promise<SessionView> {
    return await this.client.unpinSession(session);
  }
}

/**
 * Pins an agent to the top of the sidebar: `fy session pin <session>` and `fy session unpin <session>`.
 *
 * (`fy pin` is the session note board, which is why this is a `session` verb.) Both are idempotent, and
 * `fy ps` marks the pinned ferrets. The session may be named by id or first name.
 */
export class PinAgentController {
  constructor(
    private readonly gateway: ISessionPinGateway,
    private readonly presenter: SessionPresenter,
  ) {}

  async pin(reference: string, flags: { readonly json?: boolean } = {}): Promise<void> {
    const view = await this.gateway.pin(named(reference, 'pin'));
    if (flags.json === true) this.presenter.json(view);
    else this.presenter.lines([`pinned ${label(view)} to the top of the sidebar`]);
  }

  async unpin(reference: string, flags: { readonly json?: boolean } = {}): Promise<void> {
    const view = await this.gateway.unpin(named(reference, 'unpin'));
    if (flags.json === true) this.presenter.json(view);
    else this.presenter.lines([`unpinned ${label(view)}`]);
  }
}

function named(reference: string, verb: string): string {
  const session = reference.trim();
  if (session === '') throw new SessionCommandError(`name the session to ${verb}`);
  return session;
}

const label = (view: SessionView): string => `${view.config.teammate ?? view.config.name} (${view.config.id})`;

/** `fy session pin|unpin <session> [--json]`. Wiring only; the controller decides. */
export function registerSessionPinCommands(
  program: Command,
  controller: PinAgentController,
  presenter: SessionPresenter,
): void {
  const session =
    program.commands.find(command => command.name() === 'session') ??
    program.command('session').description("act on a session's own standing with this daemon");
  const verb = (name: 'pin' | 'unpin', description: string): void => {
    session
      .command(name)
      .description(description)
      .argument('<session>', 'session id or first name')
      .option('--json', 'print the session as JSON')
      .action(async (reference: string, options: { readonly json?: boolean }) => {
        try {
          await controller[name](reference, options.json === true ? { json: true } : {});
        } catch (error) {
          presenter.fail(error);
        }
      });
  };
  verb('pin', 'pin a ferret to the top of the sidebar');
  verb('unpin', 'unpin a ferret from the top of the sidebar');
}
