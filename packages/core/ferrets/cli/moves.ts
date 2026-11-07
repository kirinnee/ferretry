import type { CliContext, VerbHandler } from '@ferretry/kernel/manifest';
import type manifest from '../manifest.ts';
import { moveVerb } from './lib/move/commands.ts';
import { MoveController } from './lib/move/controller.ts';
import { ClientMoveGateway, type MoveClient } from './lib/move/gateway.ts';
import type { SessionPresenter } from './lib/session/presenter.ts';

/** What the move verb is built from beside the CLI context: ferrets-a's presenter, and a header-carrying client. */
export interface MoveVerbDeps {
  readonly presenter: SessionPresenter;
  /** `ctx.client` once the kernel's `PluginClient` carries request headers; see `MoveClient`. */
  readonly client: MoveClient;
  /** Mints the move's logical request id when `--request-id` is not given (today: `crypto.randomUUID`). */
  readonly mintRequestId: () => string;
}

/** Ferrets' CLI verbs from this unit (ferrets-c): `fy ferret move <id>`. Spread into the CLI half's `verbs`. */
export function buildMoveVerbs(
  _ctx: CliContext<typeof manifest>,
  deps: MoveVerbDeps,
): { readonly 'ferret move <id>': VerbHandler } {
  const controller = new MoveController(new ClientMoveGateway(deps.client, deps.mintRequestId), deps.presenter);
  return { 'ferret move <id>': moveVerb(controller) };
}
