import { SessionCommandError } from './errors.ts';
import type { ISessionApi } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';

/** Revives a stopped ferret with its conversation intact: `fy resume`. */
export class ResumeSessionController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
  ) {}

  async execute(id: string, flags: { message?: string; json?: boolean } = {}): Promise<void> {
    const message = flags.message?.trim();
    // A message on revival is the Conversation's to deliver; resume itself carries none.
    if (message !== undefined && message !== '')
      throw new SessionCommandError(
        'resume revives the ferret only; send the message once it is up (fy send <ferret> <message>)',
      );
    const resumed = await this.api.resume(id);
    this.presenter.view(await this.api.get(resumed.id), flags.json === true);
  }
}
