import type { FerretSummary } from '../../../contract/index.ts';
import { SessionCommandError } from './errors.ts';
import type { SessionPresenter } from './presenter.ts';

/** A ferret as the pin routes answer it: carrying `pinnedAt` while pinned. */
export type PinnedView = FerretSummary;

/** The two routes `fy session pin` and `fy session unpin` speak. */
export interface ISessionPinGateway {
  pin(session: string): Promise<PinnedView>;
  unpin(session: string): Promise<PinnedView>;
}

/**
 * Pins a ferret to the top of the sidebar: `fy session pin <ferret>` and `fy session unpin <ferret>`.
 *
 * (`fy pin` is the note board, which is why this is a `session` verb.) Both are idempotent, and `fy ps` marks the
 * pinned ferrets. The ferret may be named by id or first name.
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
  if (session === '') throw new SessionCommandError(`name the ferret to ${verb}`);
  return session;
}

const label = (view: PinnedView): string => `${view.name} (${view.id})`;
